import { createPostgresStore } from "./postgres-store.mjs";
import { OutboxRelay, outboxConfig } from "./outbox-relay.mjs";
import { validateProductionConfig } from "./production-config.mjs";

validateProductionConfig(process.env, { component: "outbox" });
const store = createPostgresStore();
const config = outboxConfig();
const relay = new OutboxRelay({ store, config, onResult: (result) => console.log(JSON.stringify({ level: result.status === "published" ? "info" : "warn", component: "outbox-relay", ...result, time: new Date().toISOString() })) });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

try {
  while (!stopping) {
    const result = await relay.runOnce();
    if (result.claimed === 0) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
} finally {
  await store.close();
}
