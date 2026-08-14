import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublisherOptions } from "../integrations/sumi-docs-publisher.mjs";

const valid = () => ({
  sourceRoot: "docs",
  documents: [
    { source: "QUICKSTART.md", machine: "quickstart.md", page: "/quickstart/" },
  ],
  openapi: { source: "contracts/openapi.yaml", output: "openapi.json" },
});

test("publisher accepts explicit source, machine, page, and OpenAPI mappings", () => {
  assert.deepEqual(normalizePublisherOptions(valid()), valid());
});

test("publisher rejects traversal and unknown mapping fields", () => {
  const traversal = valid();
  traversal.documents[0].source = "../README.md";
  assert.throws(() => normalizePublisherOptions(traversal), /restricted relative/);

  const unknown = valid();
  unknown.documents[0].locale = "en";
  assert.throws(() => normalizePublisherOptions(unknown), /unknown field/);
});

test("publisher rejects duplicate machine identities and routes", () => {
  const duplicateMachine = valid();
  duplicateMachine.documents.push({
    source: "API.md",
    machine: "quickstart.md",
    page: "/api/",
  });
  assert.throws(() => normalizePublisherOptions(duplicateMachine), /unique/);

  const duplicateRoute = valid();
  duplicateRoute.documents.push({
    source: "API.md",
    machine: "api.md",
    page: "/quickstart/",
  });
  assert.throws(() => normalizePublisherOptions(duplicateRoute), /unique/);
});
