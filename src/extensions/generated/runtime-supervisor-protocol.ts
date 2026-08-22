// Generated from contracts/runtime-supervisor.schema.json. Do not edit.

export const RUST_SUPERVISOR_PROTOCOL_VERSION =
  "sumi.runtime.supervisor.v1" as const;
export const EXTENSION_READY_FRAME = "sumi.runtime.extension.ready.v1" as const;
export const RUST_SUPERVISOR_LIMITS = Object.freeze({
  maxFrameBytes: 65536,
  requestIdMax: 128,
  extensionIdMax: 128,
  programMax: 4096,
  argsMax: 64,
  argumentMax: 4096,
  environmentKeysMax: 32,
  environmentValueMax: 8192,
  timeoutMax: 30000,
  errorCodeMax: 64,
  errorMessageMax: 512,
});
export const SUPERVISOR_STATES = [
  "created",
  "running",
  "stopped",
  "failed",
] as const;
export const SUPERVISOR_RESPONSE_KEYS = [
  "protocol",
  "request_id",
  "ok",
  "state",
  "ready",
  "child_pid",
  "forced",
  "exit_code",
  "signal",
  "error",
] as const;

export type SupervisorState = (typeof SUPERVISOR_STATES)[number];
export type SupervisorError = { code: string; message: string };
export type SupervisorStartRequest = {
  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;
  request_id: string;
  op: "start";
  extension_id: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  startup_timeout_ms: number;
  shutdown_grace_ms: number;
};
export type SupervisorHealthRequest = {
  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;
  request_id: string;
  op: "health";
};
export type SupervisorStopRequest = {
  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;
  request_id: string;
  op: "stop";
};
export type SupervisorRequest =
  SupervisorStartRequest | SupervisorHealthRequest | SupervisorStopRequest;
export type SupervisorResponse = {
  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;
  request_id: string;
  ok: boolean;
  state: SupervisorState;
  ready?: boolean;
  child_pid?: number;
  forced?: boolean;
  exit_code?: number;
  signal?: number;
  error?: SupervisorError;
};
