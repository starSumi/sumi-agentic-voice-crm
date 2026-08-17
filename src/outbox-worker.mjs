import { createPostgresStore } from "./postgres-store.mjs";
import { OutboxRelay, outboxConfig } from "./outbox-relay.mjs";
import { validateProductionConfig } from "./production-config.mjs";

validateProductionConfig(process.env, { component: "outbox" });
const store = createPostgresStore();
const config = outboxConfig();
const relay = new OutboxRelay({ store, config, onResult: (result) => console.log(JSON.stringify({ level: result.status === "published" ? "info" : "warn", component: "outbox-relay", ...result, time: new Date().toISOString() })) });
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (!shutdown.signal.aborted) shutdown.abort(Object.assign(new Error(`${signal} received`), { name: "AbortError" }));
});

try {
  while (!shutdown.signal.aborted) {
    const result = await relay.runOnce({ signal: shutdown.signal });
    if (result.claimed === 0) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          shutdown.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, config.pollIntervalMs);
        shutdown.signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  await store.close();
}
