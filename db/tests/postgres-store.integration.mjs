import assert from "node:assert/strict";
import policy from "../../contracts/authorization-policy.json" with { type: "json" };
import { evaluateAuthorization } from "../../src/authorization/policy.ts";
import { PostgresCrmStore } from "../../src/postgres-store.ts";

const authorize = (request) => evaluateAuthorization(policy, request);
const store = new PostgresCrmStore({
  connectionString: process.env.DATABASE_URL,
  authorize,
});
const agentScopes = [
  "interaction.ask",
  "crm.search",
  "crm.customer.create",
  "crm.deal.update_stage",
  "media.tts.create",
  "media.asset.read",
  "events.read",
  "progress.subscribe",
];
const identity = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  actor_id: "actor-a",
  principal_kind: "human",
  token_scopes: agentScopes,
  authentication_methods: ["integration_token"],
};
const reviewerIdentity = {
  tenant_id: identity.tenant_id,
  actor_id: "actor-reviewer",
  principal_kind: "human",
  token_scopes: [
    "crm.search",
    "crm.customer.create",
    "crm.deal.update_stage",
    "review.decide",
    "media.asset.read",
    "events.read",
    "progress.subscribe",
  ],
  authentication_methods: ["integration_token"],
};

function assertPolicyDenial(error, reason) {
  assert.equal(error.code, "FORBIDDEN");
  assert.deepEqual(Object.keys(error.details).sort(), [
    "policy_version",
    "reason_codes",
  ]);
  assert.ok(error.details.reason_codes.includes(reason));
  return true;
}

async function tenantQuery(text, values = []) {
  const client = await store.pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [
      identity.tenant_id,
    ]);
    const result = await client.query(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

try {
  const upgradedInteraction = {
    tenant_id: "00000000-0000-4000-8000-000000000090",
    actor_id: "actor-upgrade",
    request_id: "req_upgrade_processing_recovered",
    idempotency_key: "upgrade-processing",
    request_fingerprint: "9".repeat(64),
    input_type: "text",
    input_payload: { text: "recover historical processing row" },
  };
  assert.deepEqual(await store.beginInteraction(upgradedInteraction), {
    replay: false,
    recovered: true,
  });
  await store.failInteraction({
    ...upgradedInteraction,
    error_code: "UPSTREAM_UNAVAILABLE",
    error_message: "upgrade fixture stop",
    http_status: 503,
  });
  const upgradeInspection = await store.pool.connect();
  try {
    await upgradeInspection.query("begin");
    await upgradeInspection.query(
      "select set_config('app.tenant_id', $1, true)",
      [upgradedInteraction.tenant_id],
    );
    const upgradeTypes = (
      await upgradeInspection.query(
        "select w.entry_type from interaction_wal w join voice_interactions i on i.id=w.interaction_id where i.tenant_id=$1 and i.idempotency_key=$2 order by w.sequence",
        [upgradedInteraction.tenant_id, upgradedInteraction.idempotency_key],
      )
    ).rows.map(({ entry_type }) => entry_type);
    assert.deepEqual(upgradeTypes, ["recovered", "failed"]);
    await upgradeInspection.query("rollback");
  } finally {
    upgradeInspection.release();
  }

  const principal = await store.principalFor(identity);
  assert.equal(principal.subject_id, identity.actor_id);
  assert.equal(principal.kind, "human");
  assert.equal(principal.status, "active");
  assert.deepEqual(principal.roles, ["agent"]);
  assert.deepEqual(principal.token_scopes, agentScopes);
  assert.ok(principal.actor_scopes.includes("crm.customer.create"));
  assert.equal(typeof principal.policy_version, "string");

  await assert.rejects(
    store.principalFor({
      ...identity,
      actor_id: "actor-suspended",
      token_scopes: ["crm.customer.create"],
    }),
    (error) => assertPolicyDenial(error, "DEFAULT_DENY"),
  );

  const defaultDenyStore = new PostgresCrmStore({
    connectionString: process.env.DATABASE_URL,
  });
  try {
    await assert.rejects(
      defaultDenyStore.execute({
        ...identity,
        request_id: "req_runtime_default_deny_0001",
        idempotency_key: "runtime-default-deny-0001",
        request_fingerprint: "d".repeat(64),
        intent: "crm.customer.create",
        entities: { customer: { name: "Must Not Exist" } },
      }),
      (error) => assertPolicyDenial(error, "DEFAULT_DENY"),
    );
  } finally {
    await defaultDenyStore.close();
  }

  await assert.rejects(
    store.execute({
      ...identity,
      token_scopes: ["crm.search"],
      request_id: "req_runtime_token_revoked_0001",
      idempotency_key: "runtime-token-revoked-0001",
      request_fingerprint: "e".repeat(64),
      intent: "crm.customer.create",
      entities: { customer: { name: "Token Revoked" } },
    }),
    (error) => assertPolicyDenial(error, "TOKEN_SCOPE_DENY"),
  );

  await assert.rejects(
    store.execute({
      ...identity,
      request_id: "req_runtime_review_obligation_0001",
      idempotency_key: "runtime-review-obligation-0001",
      request_fingerprint: "2".repeat(64),
      intent: "crm.customer.create",
      entities: { customer: { name: "Review Required" } },
    }),
    (error) => assertPolicyDenial(error, "OBLIGATION_UNSATISFIED"),
  );

  await tenantQuery(
    "update actors set scopes=$3::jsonb where tenant_id=$1 and subject=$2",
    [identity.tenant_id, identity.actor_id, JSON.stringify(["crm.search"])],
  );
  try {
    await assert.rejects(
      store.execute({
        ...identity,
        request_id: "req_runtime_actor_revoked_0001",
        idempotency_key: "runtime-actor-revoked-0001",
        request_fingerprint: "f".repeat(64),
        intent: "crm.customer.create",
        entities: { customer: { name: "Actor Revoked" } },
      }),
      (error) => assertPolicyDenial(error, "ACTOR_SCOPE_DENY"),
    );
  } finally {
    await tenantQuery(
      "update actors set scopes=$3::jsonb where tenant_id=$1 and subject=$2",
      [identity.tenant_id, identity.actor_id, JSON.stringify(agentScopes)],
    );
  }

  const deniedCommands = await tenantQuery(
    "select count(*)::integer as count from crm_commands where tenant_id=$1 and idempotency_key = any($2::text[])",
    [
      identity.tenant_id,
      [
        "runtime-default-deny-0001",
        "runtime-token-revoked-0001",
        "runtime-review-obligation-0001",
        "runtime-actor-revoked-0001",
      ],
    ],
  );
  assert.equal(deniedCommands.rows[0].count, 0);

  const command = {
    ...identity,
    request_id: "req_runtime_postgres_0001",
    idempotency_key: "runtime-pg-key-0001",
    request_fingerprint: "3".repeat(64),
    intent: "crm.search",
    entities: { query: { value: "Runtime Customer" } },
  };
  const first = await store.execute(command);
  assert.equal(first.action, "read_only");
  const replay = await store.execute({
    ...command,
    request_id: "req_runtime_postgres_0002",
  });
  assert.deepEqual(replay, first);
  await assert.rejects(
    store.execute({
      ...command,
      request_id: "req_runtime_postgres_0003",
      request_fingerprint: "4".repeat(64),
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const conversation = await store.initializeConversationState({
    ...identity,
    conversation_id: "runtime-conversation-0001",
    state: { active_customer_id: null, turn_count: 0 },
  });
  assert.deepEqual(conversation, {
    created: true,
    conversation_id: "runtime-conversation-0001",
    revision: 0,
    state: { active_customer_id: null, turn_count: 0 },
  });
  assert.deepEqual(
    await store.replaceConversationStateIfCurrent({
      ...identity,
      conversation_id: conversation.conversation_id,
      expected_revision: 0,
      state: { active_customer_id: null, turn_count: 1 },
    }),
    {
      replaced: true,
      conversation_id: conversation.conversation_id,
      revision: 1,
    },
  );
  assert.deepEqual(
    await store.replaceConversationStateIfCurrent({
      ...identity,
      conversation_id: conversation.conversation_id,
      expected_revision: 0,
      state: { stale: true },
    }),
    { replaced: false },
  );
  assert.deepEqual(
    await store.conversationState({
      ...identity,
      conversation_id: conversation.conversation_id,
    }),
    {
      conversation_id: conversation.conversation_id,
      revision: 1,
      state: { active_customer_id: null, turn_count: 1 },
    },
  );
  assert.equal(
    await store.conversationState({
      tenant_id: "00000000-0000-4000-8000-000000000002",
      actor_id: "actor-b",
      conversation_id: conversation.conversation_id,
    }),
    undefined,
  );
  const conversationInspection = await store.pool.connect();
  try {
    await conversationInspection.query("begin");
    await conversationInspection.query(
      "select set_config('app.tenant_id', $1, true)",
      [identity.tenant_id],
    );
    const rawState = (
      await conversationInspection.query(
        "select state_ciphertext,revision from conversation_states where tenant_id=$1 and conversation_id=$2",
        [identity.tenant_id, conversation.conversation_id],
      )
    ).rows[0];
    assert.equal(Number(rawState.revision), 1);
    assert.match(rawState.state_ciphertext, /^v1\./);
    assert.doesNotMatch(rawState.state_ciphertext, /active_customer_id/);
    await conversationInspection.query("rollback");
  } finally {
    conversationInspection.release();
  }

  const review = await store.createReview({
    ...identity,
    request_id: "req_runtime_postgres_0004",
    idempotency_key: "runtime-review-0001",
    request_fingerprint: "5".repeat(64),
    understanding: {
      intent: "crm.customer.create",
      entities: { customer: { name: "Needs Review" } },
    },
  });
  assert.equal(review.status, "open");
  const replayReview = await store.createReview({
    ...identity,
    request_id: "req_runtime_postgres_0005",
    idempotency_key: "runtime-review-0001",
    request_fingerprint: "5".repeat(64),
    understanding: {
      intent: "crm.customer.create",
      entities: { customer: { name: "Needs Review" } },
    },
  });
  assert.deepEqual(replayReview, review);

  const ttsAsset = {
    asset_id: "ast_01234567890123456789",
    url: "/v1/assets/ast_01234567890123456789",
    mime_type: "audio/mpeg",
    duration_ms: 500,
    status: "ready",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const ttsKey = `${identity.tenant_id}:runtime-tts-0001`;
  const assetMetadata = {
    object_key: "voice-crm/tenant-a/tts/asset.mp3",
    byte_length: 12,
    sha256: "a".repeat(64),
  };
  const storedTts = await store.recordTts(ttsKey, "6".repeat(64), ttsAsset, {
    ...identity,
    request_id: "req_runtime_postgres_0006",
    ...assetMetadata,
  });
  assert.deepEqual(await store.replayTts(ttsKey, "6".repeat(64)), storedTts);
  await assert.rejects(
    store.replayTts(ttsKey, "7".repeat(64)),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(
    await store.assetFor(identity.tenant_id, ttsAsset.asset_id),
    ttsAsset,
  );
  assert.equal(
    await store.assetFor(
      "00000000-0000-4000-8000-000000000002",
      ttsAsset.asset_id,
    ),
    undefined,
  );
  const duplicateAsset = await store.recordTts(
    `${identity.tenant_id}:runtime-tts-0002`,
    "8".repeat(64),
    ttsAsset,
    { ...identity, request_id: "req_runtime_postgres_0006b", ...assetMetadata },
  );
  assert.deepEqual(duplicateAsset, ttsAsset);

  const interaction = {
    ...identity,
    request_id: "req_runtime_interaction_0001",
    idempotency_key: "runtime-interaction-0001",
    request_fingerprint: "9".repeat(64),
    input_type: "text",
    input_payload: { text: "private interaction input", locale: "en-US" },
  };
  assert.deepEqual(await store.beginInteraction(interaction), {
    replay: false,
  });
  await store.checkpointInteraction({
    ...interaction,
    transcript: { text: "private transcript" },
    understanding: { intent: "crm.search" },
    provider_invocations: [{ operation: "intent", status: "succeeded" }],
  });
  const interactionResponse = {
    status: "completed",
    request_id: interaction.request_id,
    answer: { text: "private answer" },
  };
  await store.completeInteraction({
    ...interaction,
    response: interactionResponse,
    http_status: 200,
  });
  assert.deepEqual(await store.beginInteraction(interaction), {
    replay: true,
    response: interactionResponse,
    http_status: 200,
  });
  const inspection = await store.pool.connect();
  try {
    await inspection.query("begin");
    await inspection.query("select set_config('app.tenant_id', $1, true)", [
      identity.tenant_id,
    ]);
    const raw = (
      await inspection.query(
        "select id,input_payload_ciphertext,transcript_ciphertext,understanding_ciphertext,response_ciphertext from voice_interactions where tenant_id=$1 and request_id=$2",
        [identity.tenant_id, interaction.request_id],
      )
    ).rows[0];
    assert.ok(
      [
        raw.input_payload_ciphertext,
        raw.transcript_ciphertext,
        raw.understanding_ciphertext,
        raw.response_ciphertext,
      ].every((value) => String(value).startsWith("v1.")),
    );
    assert.doesNotMatch(
      JSON.stringify(raw),
      /private interaction|private transcript|private answer/,
    );
    const journal = await inspection.query(
      "select sequence,entry_type,payload_ciphertext from interaction_wal where tenant_id=$1 and interaction_id=$2 order by sequence",
      [identity.tenant_id, raw.id],
    );
    assert.deepEqual(
      journal.rows.map(({ sequence, entry_type }) => ({
        sequence: Number(sequence),
        entry_type,
      })),
      [
        { sequence: 1, entry_type: "started" },
        { sequence: 2, entry_type: "checkpointed" },
        { sequence: 3, entry_type: "completed" },
      ],
    );
    assert.ok(
      journal.rows.every(({ payload_ciphertext }) =>
        payload_ciphertext.startsWith("v1."),
      ),
    );
    await inspection.query("savepoint wal_immutability");
    await assert.rejects(
      inspection.query(
        "update interaction_wal set entry_type='failed' where tenant_id=$1 and interaction_id=$2",
        [identity.tenant_id, raw.id],
      ),
      (error) => error.code === "55000" && /append-only/.test(error.message),
    );
    await inspection.query("rollback to savepoint wal_immutability");
    await inspection.query("rollback");
  } finally {
    inspection.release();
  }

  const stale = {
    ...identity,
    request_id: "req_runtime_stale_0001",
    idempotency_key: "runtime-stale-0001",
    request_fingerprint: "b".repeat(64),
    input_type: "text",
    input_payload: { text: "recover me" },
  };

  const abandoned = {
    ...identity,
    request_id: "req_runtime_abandoned_0001",
    idempotency_key: "runtime-abandoned-0001",
    request_fingerprint: "a".repeat(64),
    input_type: "text",
    input_payload: { text: "cancel me" },
  };
  assert.deepEqual(await store.beginInteraction(abandoned), { replay: false });
  assert.deepEqual(await store.abandonInteraction(abandoned), {
    released: true,
  });
  const abandonedRecovery = {
    ...abandoned,
    request_id: "req_runtime_abandoned_0002",
  };
  assert.deepEqual(await store.beginInteraction(abandonedRecovery), {
    replay: false,
    recovered: true,
  });
  await store.failInteraction({
    ...abandonedRecovery,
    error_code: "UPSTREAM_UNAVAILABLE",
    error_message: "fixture stop",
    http_status: 503,
  });
  const abandonedInspection = await store.pool.connect();
  try {
    await abandonedInspection.query("begin");
    await abandonedInspection.query(
      "select set_config('app.tenant_id', $1, true)",
      [identity.tenant_id],
    );
    const abandonedTypes = (
      await abandonedInspection.query(
        "select w.entry_type from interaction_wal w join voice_interactions i on i.id=w.interaction_id where i.tenant_id=$1 and i.idempotency_key=$2 order by w.sequence",
        [identity.tenant_id, abandoned.idempotency_key],
      )
    ).rows.map(({ entry_type }) => entry_type);
    assert.deepEqual(abandonedTypes, [
      "started",
      "abandoned",
      "recovered",
      "failed",
    ]);
    await abandonedInspection.query("rollback");
  } finally {
    abandonedInspection.release();
  }

  assert.deepEqual(await store.beginInteraction(stale), { replay: false });
  const lease = await store.pool.connect();
  try {
    await lease.query("begin");
    await lease.query("select set_config('app.tenant_id', $1, true)", [
      identity.tenant_id,
    ]);
    await lease.query(
      "update voice_interactions set lease_expires_at=now()-interval '1 second' where tenant_id=$1 and request_id=$2",
      [identity.tenant_id, stale.request_id],
    );
    await lease.query("commit");
  } finally {
    lease.release();
  }
  await assert.rejects(
    store.completeInteraction({
      ...stale,
      response: { status: "completed", request_id: stale.request_id },
      http_status: 200,
    }),
    (error) => error.code === "CRM_CONFLICT",
  );
  await store.failInteraction({
    ...stale,
    error_code: "UPSTREAM_UNAVAILABLE",
    error_message: "late failure",
    http_status: 503,
  });
  const recovered = { ...stale, request_id: "req_runtime_stale_0002" };
  assert.deepEqual(await store.beginInteraction(recovered), {
    replay: false,
    recovered: true,
  });
  await store.failInteraction({
    ...recovered,
    error_code: "UPSTREAM_UNAVAILABLE",
    error_message: "fixture recovery stop",
    http_status: 503,
  });
  const recoveryInspection = await store.pool.connect();
  try {
    await recoveryInspection.query("begin");
    await recoveryInspection.query(
      "select set_config('app.tenant_id', $1, true)",
      [identity.tenant_id],
    );
    const recoveredRow = (
      await recoveryInspection.query(
        "select id,recovery_count from voice_interactions where tenant_id=$1 and request_id=$2",
        [identity.tenant_id, recovered.request_id],
      )
    ).rows[0];
    assert.equal(recoveredRow.recovery_count, 1);
    const types = (
      await recoveryInspection.query(
        "select entry_type from interaction_wal where tenant_id=$1 and interaction_id=$2 order by sequence",
        [identity.tenant_id, recoveredRow.id],
      )
    ).rows.map(({ entry_type }) => entry_type);
    assert.deepEqual(types, ["started", "recovered", "failed"]);
    await recoveryInspection.query("rollback");
  } finally {
    recoveryInspection.release();
  }

  const decision = await store.decideReview({
    ...reviewerIdentity,
    review_id: review.id,
    decision: "reject",
    idempotency_key: "runtime-review-decision-0001",
    request_id: "req_runtime_postgres_0007",
  });
  assert.equal(decision.status, "rejected");
  const rawReviewId = review.id
    .slice(4)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const replayDecision = await store.decideReview({
    ...reviewerIdentity,
    review_id: rawReviewId,
    decision: "reject",
    idempotency_key: "runtime-review-decision-0001",
    request_id: "req_runtime_postgres_0008",
  });
  assert.deepEqual(replayDecision, decision);
  await assert.rejects(
    store.decideReview({
      ...reviewerIdentity,
      review_id: rawReviewId,
      decision: "approve",
      idempotency_key: "runtime-review-decision-0001",
      request_id: "req_runtime_postgres_0009",
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const approvalReview = await store.createReview({
    ...identity,
    request_id: "req_runtime_review_recheck_0001",
    idempotency_key: "runtime-review-recheck-0001",
    request_fingerprint: "1".repeat(64),
    understanding: {
      intent: "crm.customer.create",
      entities: { customer: { name: "Permission Rechecked" } },
    },
  });
  const approvalInput = {
    ...reviewerIdentity,
    review_id: approvalReview.id,
    decision: "approve",
    idempotency_key: "runtime-review-recheck-decision-0001",
    request_id: "req_runtime_review_recheck_0002",
  };
  await assert.rejects(
    store.decideReview({ ...approvalInput, token_scopes: ["review.decide"] }),
    (error) => assertPolicyDenial(error, "TOKEN_SCOPE_DENY"),
  );
  const approvalReviewUuid = approvalReview.id
    .slice(4)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const stillOpen = await tenantQuery(
    "select status from review_tasks where tenant_id=$1 and id=$2",
    [identity.tenant_id, approvalReviewUuid],
  );
  assert.equal(stillOpen.rows[0].status, "open");
  const approved = await store.decideReview(approvalInput);
  assert.equal(approved.status, "approved");
  assert.equal(approved.decision.result.action, "created");

  const dealId = "20000000-0000-4000-8000-000000000001";
  await tenantQuery(
    `insert into deals (id,tenant_id,name,stage,probability)
     values ($1,$2,'Intent Contract Deal','Proposal',50)
     on conflict (id) do update set stage='Proposal',version=1`,
    [dealId, identity.tenant_id],
  );
  const dealReview = await store.createReview({
    ...identity,
    request_id: "req_runtime_deal_review_0001",
    idempotency_key: "runtime-deal-review-0001",
    request_fingerprint: "c".repeat(64),
    understanding: {
      intent: "crm.deal.update_stage",
      entities: {
        deal: { value: dealId, expected_version: 1 },
        stage: { value: "Negotiation" },
      },
    },
  });
  const approvedDeal = await store.decideReview({
    ...reviewerIdentity,
    review_id: dealReview.id,
    decision: "approve",
    idempotency_key: "runtime-deal-review-decision-0001",
    request_id: "req_runtime_deal_review_0002",
  });
  assert.equal(approvedDeal.status, "approved");
  assert.equal(approvedDeal.decision.result.action, "updated");
  const persistedDeal = await tenantQuery(
    "select stage,version from deals where tenant_id=$1 and id=$2",
    [identity.tenant_id, dealId],
  );
  assert.deepEqual(persistedDeal.rows[0], {
    stage: "Negotiation",
    version: "2",
  });

  const events = await store.events(identity.tenant_id, identity.actor_id);
  assert.ok(events.some((event) => event.type === "crm.command.committed.v1"));
  assert.ok(events.some((event) => event.type === "crm.review.requested.v1"));
  assert.equal(
    events.filter((event) => event.type === "tts.asset.created.v1").length,
    1,
  );
  assert.ok(events.every((event) => event.tenant_id === identity.tenant_id));

  const messageJobInput = {
    tenant_id: identity.tenant_id,
    actor_id: identity.actor_id,
    request_id: "req_runtime_message_job_0001",
    idempotency_key: "runtime-message-job-0001",
    request_fingerprint: "a".repeat(64),
    payload: {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      command: { input: { type: "text", text: "find customer" } },
    },
  };
  const queuedJob = await store.enqueueMessageJob(messageJobInput);
  assert.equal(queuedJob.duplicate, false);
  assert.equal(queuedJob.job.status, "job_queued");
  assert.deepEqual(
    (await store.messageJobTransitions({
      tenant_id: identity.tenant_id,
      actor_id: identity.actor_id,
      job_id: queuedJob.job.id,
    })).map(({ status }) => status),
    ["inbound", "job_queued"],
  );
  const duplicateJob = await store.enqueueMessageJob(messageJobInput);
  assert.equal(duplicateJob.duplicate, true);
  assert.equal(duplicateJob.job.id, queuedJob.job.id);
  await assert.rejects(
    store.enqueueMessageJob({
      ...messageJobInput,
      request_fingerprint: "b".repeat(64),
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  const claimedJob = (await store.claimMessageJobs({
    tenant_id: identity.tenant_id,
    worker_id: "message-job-integration-worker",
    batch_size: 10,
  }))[0];
  assert.equal(claimedJob.id, queuedJob.job.id);
  assert.equal(claimedJob.status, "running");
  const completedJob = await store.completeMessageJob({
    tenant_id: identity.tenant_id,
    job_id: claimedJob.id,
    worker_id: "message-job-integration-worker",
    result: { status: "completed", request_id: messageJobInput.request_id },
  });
  assert.equal(completedJob.status, "succeeded");
  assert.equal(
    (await store.messageJobStats({ tenant_id: identity.tenant_id })).succeeded,
    1,
  );

  const eventReceipt = await store.claimEventDelivery({
    tenant_id: identity.tenant_id,
    consumer_id: "message-job-integration-consumer",
    event_id: "evt_message_job_integration_0001",
    event_type: "crm.command.committed.v1",
    worker_id: "event-integration-worker",
  });
  assert.equal(eventReceipt.claimed, true);
  assert.deepEqual(
    await store.claimEventDelivery({
      tenant_id: identity.tenant_id,
      consumer_id: "message-job-integration-consumer",
      event_id: "evt_message_job_integration_0001",
      worker_id: "event-integration-worker-2",
    }),
    { duplicate: false, claimed: false, status: "claimed" },
  );
  assert.deepEqual(
    await store.completeEventDelivery({
      tenant_id: identity.tenant_id,
      consumer_id: "message-job-integration-consumer",
      event_id: "evt_message_job_integration_0001",
      worker_id: "event-integration-worker",
    }),
    { completed: true },
  );
  assert.deepEqual(
    await store.claimEventDelivery({
      tenant_id: identity.tenant_id,
      consumer_id: "message-job-integration-consumer",
      event_id: "evt_message_job_integration_0001",
      worker_id: "event-integration-worker-3",
    }),
    { duplicate: true, status: "completed" },
  );

  const claimed = await store.claimOutbox({
    tenant_id: identity.tenant_id,
    worker_id: "integration-worker",
    batch_size: 100,
  });
  assert.ok(claimed.length >= 3);
  await store.markOutboxFailed({
    tenant_id: identity.tenant_id,
    worker_id: "integration-worker",
    outbox_id: claimed[0].outbox_id,
    error: "fixture failure",
    max_attempts: 1,
  });
  const releasable = claimed.slice(1);
  assert.deepEqual(
    await store.releaseOutboxLeases({
      tenant_id: identity.tenant_id,
      worker_id: "integration-worker",
      outbox_ids: releasable.map(({ outbox_id }) => outbox_id),
    }),
    { released: releasable.length },
  );
  const reclaimed = await store.claimOutbox({
    tenant_id: identity.tenant_id,
    worker_id: "integration-worker-2",
    batch_size: 100,
  });
  assert.deepEqual(
    reclaimed.map(({ outbox_id }) => outbox_id).sort(),
    releasable.map(({ outbox_id }) => outbox_id).sort(),
  );
  assert.ok(reclaimed.every(({ attempts }) => Number(attempts) === 0));
  for (const row of reclaimed)
    await store.markOutboxPublished({
      tenant_id: identity.tenant_id,
      worker_id: "integration-worker-2",
      outbox_id: row.outbox_id,
    });
  console.log(
    "postgres runtime adapter passed: encrypted interaction replay, durable CRM/TTS, tenant assets, reviews and outbox leases verified",
  );
} finally {
  await store.close();
}
