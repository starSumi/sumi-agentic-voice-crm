import type { ApplicationRequestContext } from "../src/application/commands.ts";
import type { AuthIdentity } from "../src/auth.ts";

declare module "../src/composition-root.ts" {
  export function createRequestContext({
    request_id,
    traceparent,
    identity,
    signal,
    deadline_at,
  }?: {
    request_id?: string;
    traceparent?: string;
    identity?: AuthIdentity & { tenant_id: string; actor_id: string };
    signal?: AbortSignal;
    deadline_at?: number;
  }): Readonly<ApplicationRequestContext & { deadline_at?: number }>;
}
