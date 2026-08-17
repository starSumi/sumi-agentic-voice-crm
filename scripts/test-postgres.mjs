import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const executables = ["initdb", "pg_ctl", "createdb", "dropdb", "psql"];
for (const executable of executables) {
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", shell: false });
  if (probe.error || probe.status !== 0) {
    throw new Error(`${executable} is required for pnpm run test:postgres`);
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
const logPath = join(root, "postgres.log");
const port = await freePort();
const database = `sumi_test_${randomBytes(6).toString("hex")}`;
const env = { PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres", PGDATABASE: database, DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
let started = false;

try {
  console.log(`postgres integration: initialize temporary cluster on 127.0.0.1:${port}`);
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  // The logfile prevents the detached postgres server from retaining the
  // spawnSync stdout/stderr pipe and keeping the Node process open on Windows.
  try {
    run("pg_ctl", ["-D", data, "-l", logPath, "-o", `-h 127.0.0.1 -p ${port} -k ${root}`, "-w", "start"], {}, { inherit: true });
  } catch (error) {
    let postgresLog = "postgres log unavailable";
    try { postgresLog = await readFile(logPath, "utf8"); } catch {}
    throw new Error(`${error.message}\npostgres.log:\n${postgresLog}`, { cause: error });
  }
  started = true;
  console.log("postgres integration: apply migrations twice");
  run("createdb", [database], { ...env, PGDATABASE: "postgres" });
  const migrations = (await readdir("db/migrations"))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => `db/migrations/${name}`);
  if (migrations.length === 0) throw new Error("no PostgreSQL migrations found");
  run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", migrations[0]], env);
  if (migrations.includes("db/migrations/002_interaction_control_wal.sql")) {
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", `
      insert into tenants (id,slug,status)
      values ('00000000-0000-4000-8000-000000000090','migration-upgrade','active');
      insert into actors (id,tenant_id,subject,display_name,role)
      values ('10000000-0000-4000-8000-000000000090','00000000-0000-4000-8000-000000000090','actor-upgrade','Upgrade Actor','agent');
      insert into voice_interactions
        (id,tenant_id,request_id,input_type,status,idempotency_key,request_fingerprint,input_payload_ciphertext,completed_at)
      values
        ('90000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000090','req_upgrade_processing','text','processing','upgrade-processing',repeat('9',64),'v1.fixture',null),
        ('90000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000090','req_upgrade_completed','text','completed','upgrade-completed',repeat('8',64),'v1.fixture',now());
    `], env);
  }
  for (const migration of migrations.slice(1)) {
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", migration], env);
  }
  if (migrations.includes("db/migrations/002_interaction_control_wal.sql")) {
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", `
      do $$ begin
        if not exists (
          select 1 from voice_interactions
          where request_id='req_upgrade_processing'
            and lease_owner='req_upgrade_processing'
            and lease_expires_at <= now()
            and recovery_count=0
        ) then raise exception 'processing interaction was not made reclaimable'; end if;
        if exists (
          select 1 from voice_interactions
          where request_id='req_upgrade_completed'
            and (lease_owner is not null or lease_expires_at is not null)
        ) then raise exception 'completed interaction received a lease'; end if;
      end $$;
    `], env);
  }
  for (const migration of migrations) {
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", migration], env);
  }
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
