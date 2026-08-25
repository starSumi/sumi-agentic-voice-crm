import assert from "node:assert/strict";
import test from "node:test";
import { postgresPoolOptions } from "../src/postgres-store.ts";

test("PostgreSQL pool configuration carries bounded connection and query budgets", () => {
  assert.deepEqual(
    postgresPoolOptions(
      {
        DATABASE_POOL_MAX: "20",
        DATABASE_CONNECTION_TIMEOUT_MS: "4000",
        DATABASE_QUERY_TIMEOUT_MS: "20000",
        DATABASE_STATEMENT_TIMEOUT_MS: "15000",
        DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "45000",
      },
      "postgresql://db/app",
    ),
    {
      connectionString: "postgresql://db/app",
      max: 20,
      connectionTimeoutMillis: 4000,
      query_timeout: 20000,
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 45000,
      application_name: "sumi-agentic-voice-crm",
    },
  );
});

test("PostgreSQL pool configuration rejects unbounded timeouts", () => {
  assert.throws(
    () =>
      postgresPoolOptions(
        { DATABASE_STATEMENT_TIMEOUT_MS: "300001" },
        "postgresql://db/app",
      ),
    /DATABASE_STATEMENT_TIMEOUT_MS/,
  );
});
