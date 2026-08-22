import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkAuthorizationPolicy } from "../scripts/check-authorization-policy.mjs";
import { evaluateAuthorization } from "../src/authorization/index.ts";

const policy = JSON.parse(
  await readFile("contracts/authorization-policy.json", "utf8"),
);

function request({
  action = "crm.search",
  kind = "agent",
  roles = ["agent"],
  actorScopes = [action],
  tokenScopes = [action],
  principalTenant = "tenant_a",
  principalStatus = "active",
  resourceTenant = "tenant_a",
  resourceType = action === "crm.search" ? "customer" : "interaction",
  workloadId,
  authenticationMethods,
  networkZone,
} = {}) {
  return {
    action,
    principal: {
      subject_id: "subject_01",
      kind,
      tenant_id: principalTenant,
      status: principalStatus,
      roles,
      actor_scopes: actorScopes,
      ...(workloadId === undefined ? {} : { workload_id: workloadId }),
    },
    resource: {
      type: resourceType,
      id: "resource_01",
      tenant_id: resourceTenant,
    },
    context: {
      token_scopes: tokenScopes,
      ...(authenticationMethods === undefined
        ? {}
        : { authentication_methods: authenticationMethods }),
      ...(networkZone === undefined ? {} : { network_zone: networkZone }),
    },
  };
}

test("authorization contract passes schema and semantic invariants", async () => {
  const checked = await checkAuthorizationPolicy();
  assert.equal(checked.default_effect, "deny");
});

test("RBAC upper bound intersects actor and token scopes", () => {
  const allowed = evaluateAuthorization(policy, request());
  assert.equal(allowed.effect, "allow");
  assert.deepEqual(allowed.reason_codes, ["ALLOW"]);
  assert.ok(allowed.obligations.includes("tenant_filter"));

  const roleDenied = evaluateAuthorization(
    policy,
    request({ roles: ["auditor"], action: "interaction.ask" }),
  );
  assert.equal(roleDenied.effect, "deny");
  assert.ok(roleDenied.reason_codes.includes("RBAC_DENY"));

  const actorDenied = evaluateAuthorization(
    policy,
    request({ actorScopes: ["events.read"] }),
  );
  assert.equal(actorDenied.effect, "deny");
  assert.ok(actorDenied.reason_codes.includes("ACTOR_SCOPE_DENY"));

  const tokenDenied = evaluateAuthorization(
    policy,
    request({ tokenScopes: ["events.read"] }),
  );
  assert.equal(tokenDenied.effect, "deny");
  assert.ok(tokenDenied.reason_codes.includes("TOKEN_SCOPE_DENY"));
});

test("role matrix preserves distinct human, agent and workload ceilings", () => {
  const reviewer = evaluateAuthorization(
    policy,
    request({
      action: "review.decide",
      kind: "human",
      roles: ["reviewer"],
      resourceType: "review",
    }),
  );
  assert.equal(reviewer.effect, "allow");

  const auditor = evaluateAuthorization(
    policy,
    request({
      action: "events.read",
      kind: "human",
      roles: ["auditor"],
      resourceType: "event_stream",
    }),
  );
  assert.equal(auditor.effect, "allow");

  const agentCannotReview = evaluateAuthorization(
    policy,
    request({
      action: "review.decide",
      roles: ["agent"],
      resourceType: "review",
    }),
  );
  assert.equal(agentCannotReview.effect, "deny");
  assert.ok(agentCannotReview.reason_codes.includes("RBAC_DENY"));
  assert.ok(agentCannotReview.reason_codes.includes("CONDITION_DENY"));

  for (const role of ["agent", "reviewer"]) {
    const proposal = evaluateAuthorization(
      policy,
      request({
        action: "crm.deal.update_stage",
        kind: "human",
        roles: [role],
        resourceType: "deal",
      }),
    );
    assert.equal(proposal.effect, "allow");
    assert.ok(proposal.obligations.includes("human_review"));
  }
});

test("ABAC enforces tenant and resource matrices", () => {
  const tenantDenied = evaluateAuthorization(
    policy,
    request({ resourceTenant: "tenant_b" }),
  );
  assert.equal(tenantDenied.effect, "deny");
  assert.ok(tenantDenied.reason_codes.includes("CONDITION_DENY"));

  const typeDenied = evaluateAuthorization(
    policy,
    request({ resourceType: "deal", action: "interaction.ask" }),
  );
  assert.equal(typeDenied.effect, "deny");
  assert.ok(typeDenied.reason_codes.includes("CONDITION_DENY"));

  const humanMutation = evaluateAuthorization(
    policy,
    request({
      action: "crm.customer.create",
      kind: "human",
      roles: ["tenant_admin"],
      actorScopes: ["crm.*"],
      tokenScopes: ["crm.customer.create"],
      resourceType: "customer",
    }),
  );
  assert.equal(humanMutation.effect, "allow");
  assert.ok(humanMutation.obligations.includes("human_review"));
  assert.ok(humanMutation.obligations.includes("outbox_write"));
});

test("named conditions deny missing attributes and failed predicates", () => {
  const missingTenant = request();
  delete missingTenant.resource.tenant_id;
  const missing = evaluateAuthorization(policy, missingTenant);
  assert.equal(missing.effect, "deny");
  assert.deepEqual(missing.reason_codes, ["MISSING_ATTRIBUTE"]);

  const suspended = evaluateAuthorization(
    policy,
    request({ principalStatus: "suspended" }),
  );
  assert.equal(suspended.effect, "deny");
  assert.ok(suspended.reason_codes.includes("CONDITION_DENY"));

  const missingStatus = request();
  delete missingStatus.principal.status;
  assert.deepEqual(evaluateAuthorization(policy, missingStatus).reason_codes, [
    "MISSING_ATTRIBUTE",
  ]);
});

test("wildcards work only when policy explicitly permits them", () => {
  const tenantAdminMedia = evaluateAuthorization(
    policy,
    request({
      action: "media.tts.create",
      kind: "human",
      roles: ["tenant_admin"],
      actorScopes: ["media.*"],
      tokenScopes: ["media.*"],
      resourceType: "media_asset",
    }),
  );
  assert.equal(tenantAdminMedia.effect, "allow");

  const undeclared = evaluateAuthorization(
    policy,
    request({ actorScopes: ["*"] }),
  );
  assert.equal(undeclared.effect, "deny");
  assert.deepEqual(undeclared.reason_codes, ["UNKNOWN_SCOPE"]);
});

test("MFA remains an opt-in named condition and fails closed", () => {
  const mfaPolicy = structuredClone(policy);
  mfaPolicy.action_conditions["crm.customer.create"].push("mfa_present");
  const mutation = {
    action: "crm.customer.create",
    kind: "human",
    roles: ["agent"],
    resourceType: "customer",
  };

  const missingAuthentication = evaluateAuthorization(
    mfaPolicy,
    request(mutation),
  );
  assert.equal(missingAuthentication.effect, "deny");
  assert.ok(missingAuthentication.reason_codes.includes("MISSING_ATTRIBUTE"));

  const passwordOnly = evaluateAuthorization(
    mfaPolicy,
    request({ ...mutation, authenticationMethods: ["pwd"] }),
  );
  assert.equal(passwordOnly.effect, "deny");
  assert.ok(passwordOnly.reason_codes.includes("CONDITION_DENY"));

  const verifiedMfa = evaluateAuthorization(
    mfaPolicy,
    request({ ...mutation, authenticationMethods: ["pwd", "mfa"] }),
  );
  assert.equal(verifiedMfa.effect, "allow");
});

test("workload relay requires workload identity and trusted network", () => {
  const relay = {
    action: "outbox.relay",
    kind: "workload",
    roles: ["workload"],
    actorScopes: ["outbox.relay"],
    tokenScopes: ["outbox.relay"],
    resourceType: "outbox",
    workloadId: "outbox_relay_01",
    networkZone: "service",
  };
  assert.equal(evaluateAuthorization(policy, request(relay)).effect, "allow");

  const publicNetwork = evaluateAuthorization(
    policy,
    request({ ...relay, networkZone: "public" }),
  );
  assert.equal(publicNetwork.effect, "deny");
  assert.ok(publicNetwork.reason_codes.includes("CONDITION_DENY"));

  const missingWorkloadIdentity = evaluateAuthorization(
    policy,
    request({ ...relay, workloadId: undefined }),
  );
  assert.equal(missingWorkloadIdentity.effect, "deny");
  assert.ok(missingWorkloadIdentity.reason_codes.includes("MISSING_ATTRIBUTE"));
});

test("unknown action, field and condition fail closed", () => {
  const unknownAction = evaluateAuthorization(
    policy,
    request({ action: "crm.future.delete" }),
  );
  assert.equal(unknownAction.effect, "deny");
  assert.deepEqual(unknownAction.reason_codes, ["UNKNOWN_ACTION"]);

  const unknownField = request();
  unknownField.context.debug = true;
  assert.deepEqual(evaluateAuthorization(policy, unknownField).reason_codes, [
    "UNKNOWN_FIELD",
  ]);

  const unknownConditionPolicy = structuredClone(policy);
  unknownConditionPolicy.action_conditions["crm.search"].push(
    "future_condition",
  );
  const unknownCondition = evaluateAuthorization(
    unknownConditionPolicy,
    request(),
  );
  assert.equal(unknownCondition.effect, "deny");
  assert.ok(unknownCondition.reason_codes.includes("UNKNOWN_CONDITION"));
});
