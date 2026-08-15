import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDrillEnv } from "../scripts/drill-env.mjs";

test("local drills do not inherit application configuration or credentials", () => {
  const env = isolatedDrillEnv({ APP_ENV: "test", OPENAI_API_KEY: "fixture-key" }, {
    PATH: "/usr/bin",
    SAFE_FLAG: "kept",
    ALIYUN_BASE_APIKEY: "cloud-key",
    DATABASE_URL: "postgresql://user:password@example.test/db",
    DRILL_AUTHORIZATION: "Bearer inherited",
    GITHUB_TOKEN: "repository-token",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SAFE_FLAG, "kept");
  assert.equal(env.APP_ENV, "test");
  assert.equal(env.OPENAI_API_KEY, "fixture-key");
  assert.equal("ALIYUN_BASE_APIKEY" in env, false);
  assert.equal("DATABASE_URL" in env, false);
  assert.equal("DRILL_AUTHORIZATION" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
});
