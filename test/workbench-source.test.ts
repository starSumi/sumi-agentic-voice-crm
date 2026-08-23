import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile("src/pages/workbench.astro", "utf8");
const script = await readFile("src/scripts/workbench.ts", "utf8");

test("workbench keeps synchronous request state mutually exclusive with recording", () => {
  assert.match(script, /requestInFlight \|\| capturePending \|\| recording/);
  assert.match(
    script,
    /if \(requestInFlight \|\| capturePending \|\| isRecording\(\)\) return/,
  );
  assert.match(script, /if \(blob\.size === 0\)/);
  assert.match(
    script,
    /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/,
  );
  assert.match(script, /addEventListener\(\s*"error"/);
  assert.match(script, /addEventListener\(\s*"stop"/);
});

test("workbench discriminates every generated response envelope before completion", () => {
  for (const guard of [
    "isAskPayload",
    "isReviewPayload",
    "isReviewDecisionPayload",
    "isErrorPayload",
  ]) {
    assert.match(script, new RegExp(`function ${guard}\\(`));
  }
  assert.match(script, /response\.error !== undefined/);
  assert.doesNotMatch(script, /response\.data\s*\?\?\s*response\.error/);
  assert.match(script, /showMalformed\(response\.data/);
});

test("workbench HITL keeps correction parsing and focus management in the UI boundary", () => {
  assert.match(page, /id="review-understanding"/);
  assert.match(page, /id="review-correction"/);
  assert.match(page, /id="review-error" role="alert"/);
  assert.match(script, /if \(!isRecord\(parsed\)\) throw new Error/);
  assert.match(script, /reviewCorrection\.focus\(\)/);
  assert.match(script, /reviewPanel\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /reviewReturnFocus\.focus\(\{ preventScroll: true \}\)/);
});

test("workbench is a quiet bounded tool surface with no unsafe default command", () => {
  assert.match(page, /<textarea id="text"[^>]*><\/textarea>/);
  assert.doesNotMatch(page, /gradient\s*\(/i);
  for (const match of page.matchAll(/border-radius:\s*(\d+)px/g)) {
    assert.ok(Number(match[1]) <= 8, `border radius exceeds 8px: ${match[0]}`);
  }
  assert.doesNotMatch(script, /\bfetch\s*\(/);
  assert.doesNotMatch(script, /\bclient\.(?:get|post|put|delete|patch)\s*\(/);
});

test("protected audio uses the generated authenticated content operation and revokes object URLs", () => {
  assert.match(script, /import[\s\S]*getAssetContent/);
  assert.match(
    script,
    /getAssetContent\(\{[\s\S]*path: \{ asset_id: asset\.asset_id \}[\s\S]*parseAs: "blob"/,
  );
  assert.match(script, /URL\.createObjectURL\(response\.data\)/);
  assert.match(script, /URL\.revokeObjectURL\(audioObjectUrl\)/);
  assert.doesNotMatch(script, /audio\.src\s*=\s*asset\.url/);
  assert.doesNotMatch(script, /audioLink\.href\s*=\s*asset\.url/);
});
