import assert from "node:assert/strict";
import test from "node:test";
import { PostgresCrmStore } from "../src/postgres-store.mjs";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_UUID = "10000000-0000-4000-8000-000000000001";
const REVIEW_UUID = "40000000-0000-4000-8000-000000000001";

function poolFixture({
  role = "agent",
  scopes = ["crm.customer.create"],
  review,
} = {}) {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text === "begin" || text === "commit" || text === "rollback")
        return { rowCount: 0, rows: [] };
      if (text.startsWith("select set_config"))
        return { rowCount: 1, rows: [{}] };
      if (text.startsWith("select id,policy_version from tenants")) {
        return {
          rowCount: 1,
          rows: [{ id: TENANT_ID, policy_version: "tenant-policy.v1" }],
        };
      }
      if (text.startsWith("select id,role,scopes,status from actors")) {
        return {
          rowCount: 1,
          rows: [{ id: ACTOR_UUID, role, scopes, status: "active" }],
        };
      }
      if (
        text.startsWith(
          "select request_fingerprint,result from review_decisions",
        )
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("select r.*, c.id as command_id")) {
        return { rowCount: 1, rows: [review] };
      }
      throw new Error(`unexpected database effect: ${text}`);
    },
    release() {},
  };
  return {
    queries,
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

function identity(overrides = {}) {
  return {
    tenant_id: TENANT_ID,
    actor_id: "actor-a",
    principal_kind: "human",
    token_scopes: ["crm.customer.create"],
    authentication_methods: ["test_token"],
    ...overrides,
  };
}

function allow() {
  return {
    effect: "allow",
    policy_version: "policy.v1",
    reason_codes: ["ALLOW"],
    obligations: [],
  };
}

function deny(reason) {
  return {
    effect: "deny",
    policy_version: "policy.v1",
    reason_codes: [reason],
    obligations: ["audit_log"],
  };
}

test("principalFor returns fresh actor facts while preserving token facts", async () => {
  const fixture = poolFixture();
  const store = new PostgresCrmStore({ pool: fixture.pool, cipher: {} });
  const principal = await store.principalFor(
    identity({ subject_id: "untrusted-alias" }),
  );
  assert.equal(principal.subject_id, "actor-a");
  assert.equal(principal.actor_uuid, ACTOR_UUID);
  assert.deepEqual(principal.roles, ["agent"]);
  assert.deepEqual(principal.actor_scopes, ["crm.customer.create"]);
  assert.equal(principal.status, "active");
  assert.deepEqual(principal.token_scopes, ["crm.customer.create"]);
  assert.equal(principal.policy_version, "tenant-policy.v1");
});

test("PostgreSQL mutations default-deny before their first write", async () => {
  const fixture = poolFixture();
  const store = new PostgresCrmStore({ pool: fixture.pool, cipher: {} });
  await assert.rejects(
    store.execute({
      ...identity(),
      request_id: "req_pg_authorization_0001",
      idempotency_key: "pg-authorization-0001",
      intent: "crm.customer.create",
      entities: { customer: { name: "Denied" } },
    }),
    (error) => {
      assert.equal(error.code, "FORBIDDEN");
      assert.deepEqual(error.details, {
        policy_version: "tenant-policy.v1",
        reason_codes: ["DEFAULT_DENY"],
      });
      return true;
    },
  );
  assert.ok(fixture.queries.includes("rollback"));
  assert.ok(
    !fixture.queries.some((query) =>
      query.startsWith("insert into crm_commands"),
    ),
  );
});

test("PostgreSQL direct mutations cannot bypass a human-review obligation", async () => {
  const fixture = poolFixture();
  const store = new PostgresCrmStore({
    pool: fixture.pool,
    cipher: {},
    authorize: async () => ({
      ...allow(),
      obligations: ["human_review"],
    }),
  });
  await assert.rejects(
    store.execute({
      ...identity(),
      request_id: "req_pg_review_obligation_0001",
      idempotency_key: "pg-review-obligation-0001",
      intent: "crm.customer.create",
      entities: { customer: { name: "Denied" } },
    }),
    (error) =>
      error.code === "FORBIDDEN" &&
      error.details.reason_codes[0] === "OBLIGATION_UNSATISFIED",
  );
  assert.ok(fixture.queries.includes("rollback"));
  assert.ok(
    !fixture.queries.some((query) =>
      query.startsWith("insert into crm_commands"),
    ),
  );
});

test("review creation rechecks the original CRM action before persistence", async () => {
  const fixture = poolFixture();
  let observed;
  const store = new PostgresCrmStore({
    pool: fixture.pool,
    cipher: {},
    authorize: async (request) => {
      observed = request;
      return deny("ACTOR_SCOPE_DENY");
    },
  });
  await assert.rejects(
    store.createReview({
      ...identity(),
      request_id: "req_pg_review_create_0001",
      idempotency_key: "pg-review-create-0001",
      request_fingerprint: "a".repeat(64),
      understanding: {
        intent: "crm.customer.create",
        entities: { customer: { name: "Denied review" } },
      },
    }),
    (error) =>
      error.code === "FORBIDDEN" &&
      error.details.reason_codes[0] === "ACTOR_SCOPE_DENY",
  );
  assert.equal(observed.action, "crm.customer.create");
  assert.equal(observed.resource.type, "customer");
  assert.ok(
    !fixture.queries.some((query) =>
      query.startsWith("insert into crm_commands"),
    ),
  );
  assert.ok(
    !fixture.queries.some((query) =>
      query.startsWith("insert into review_tasks"),
    ),
  );
});

test("review approval cannot elevate permission to the stored mutation", async () => {
  const fixture = poolFixture({
    role: "reviewer",
    scopes: ["review.decide", "crm.customer.create"],
    review: {
      id: REVIEW_UUID,
      command_id: "30000000-0000-4000-8000-000000000001",
      intent: "crm.customer.create",
      payload: {
        understanding: { entities: { customer: { name: "Denied approval" } } },
      },
      status: "open",
    },
  });
  const actions = [];
  const store = new PostgresCrmStore({
    pool: fixture.pool,
    cipher: {},
    authorize: async (request) => {
      actions.push(request);
      return request.action === "review.decide"
        ? allow()
        : deny("TOKEN_SCOPE_DENY");
    },
  });
  await assert.rejects(
    store.decideReview({
      ...identity({ token_scopes: ["review.decide"] }),
      review_id: REVIEW_UUID,
      decision: "approve",
      idempotency_key: "pg-review-decision-0001",
      request_id: "req_pg_review_0001",
    }),
    (error) =>
      error.code === "FORBIDDEN" &&
      error.details.reason_codes[0] === "TOKEN_SCOPE_DENY",
  );
  assert.deepEqual(
    actions.map(({ action }) => action),
    ["review.decide", "crm.customer.create"],
  );
  assert.equal(actions[1].resource.type, "customer");
  assert.ok(fixture.queries.includes("rollback"));
  assert.ok(
    !fixture.queries.some((query) => query.startsWith("insert into customers")),
  );
  assert.ok(
    !fixture.queries.some((query) => query.startsWith("update review_tasks")),
  );
});
