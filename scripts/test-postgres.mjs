import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const executables = ["initdb", "pg_ctl", "createdb", "dropdb", "psql"];
for (const executable of executables) {
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", shell: false });
  if (probe.error || probe.status !== 0) {
    throw new Error(`${executable} is required for npm run test:postgres`);
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.unref();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
}

function run(command, args, environment = {}, { inherit = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: inherit ? undefined : "utf8",
    shell: false,
    env: { ...process.env, ...environment },
    timeout: 30_000,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

const root = await mkdtemp(join(tmpdir(), "sumi-postgres-"));
const data = join(root, "data");
const port = await freePort();
const database = `sumi_test_${randomBytes(6).toString("hex")}`;
const env = { PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres", PGDATABASE: database, DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
let started = false;

try {
  console.log(`postgres integration: initialize temporary cluster on 127.0.0.1:${port}`);
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  // The logfile prevents the detached postgres server from retaining the
  // spawnSync stdout/stderr pipe and keeping the Node process open on Windows.
  run("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], {}, { inherit: true });
  started = true;
  console.log("postgres integration: apply migration twice");
  run("createdb", [database], { ...env, PGDATABASE: "postgres" });
  run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", "db/migrations/001_initial.sql"], env);
  run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", "db/migrations/001_initial.sql"], env);
  console.log("postgres integration: exercise RLS and transaction atomicity");
  const evidence = run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", "db/tests/001_rls_and_atomicity.sql"], env);
  if (!evidence.includes("sumi postgres integration passed")) {
    throw new Error("PostgreSQL test did not emit its acceptance marker");
  }
  const runtimeUrl = `postgresql://sumi_app@127.0.0.1:${port}/${database}`;
  run(process.execPath, ["db/tests/postgres-store.integration.mjs"], { ...env, DATABASE_URL: runtimeUrl }, { inherit: true });
  console.log(`postgres integration passed: migration reapplied cleanly, two-tenant RLS and atomic commit/rollback verified on PostgreSQL ${run("psql", ["--version"], env).trim()}`);
} finally {
  let hasPid = false;
  try { await access(join(data, "postmaster.pid")); hasPid = true; } catch {}
  if (started || hasPid) {
    try { run("dropdb", ["--if-exists", database], { ...env, PGDATABASE: "postgres" }); } catch (error) { console.error(error.message); }
    try { run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], {}, { inherit: true }); } catch (error) { console.error(error.message); }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
