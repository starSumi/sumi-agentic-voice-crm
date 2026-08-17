import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { TRANSPORT_PREFERENCES } from "../packages/api-client/src/transport.ts";

export async function checkTransportPolicy() {
  const [schema, policy] = await Promise.all([
    readFile("contracts/transport-policy.schema.json", "utf8").then(JSON.parse),
    readFile("contracts/transport-policy.json", "utf8").then(JSON.parse),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(policy)) {
    throw new Error(
      `transport policy schema failed: ${ajv.errorsText(validate.errors)}`,
    );
  }

  assert.deepEqual(policy.profiles, TRANSPORT_PREFERENCES);
  assert.equal(
    policy.semantics.protocol_types,
    "packages/api-client/src/protocol.ts",
  );
  assert.equal(policy.semantics.api_client, "packages/api-client/src/api.ts");
  assert.equal(policy.semantics.application_core, "src/application");
  assert.equal(policy.profiles.browser.at(-1), "http");
  assert.equal(policy.profiles.desktop.at(-1), "http");
  assert.equal(policy.profiles.tui.at(-1), "http");
  assert.equal(policy.profiles.service.at(-1), "http");
  assert.deepEqual(policy.transports.grpc.clients, ["service"]);
  assert.equal(policy.transports.webtransport.status, "experimental");
  assert.equal(policy.standards.webtransport_api.maturity, "working-draft");
  assert.equal(
    policy.standards.webtransport_protocol.maturity,
    "internet-draft",
  );

  for (const [kind, transport] of Object.entries(policy.transports)) {
    assert.equal(new Set(transport.fallback).size, transport.fallback.length);
    for (const fallback of transport.fallback) {
      assert.ok(
        policy.transports[fallback],
        `${kind} references unknown fallback ${fallback}`,
      );
    }
    if (kind !== "http") assert.equal(transport.fallback.at(-1), "http");
  }
  return policy;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const policy = await checkTransportPolicy();
  console.log(
    `transport policy passed: ${Object.keys(policy.transports).length} adapters, ${Object.keys(policy.profiles).length} client profiles`,
  );
}
