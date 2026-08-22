import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const sourcePath = "contracts/runtime-supervisor.schema.json";

function required(value, label) {
  if (value === undefined || value === null)
    throw new Error(`runtime supervisor schema omitted ${label}`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`runtime supervisor schema has invalid ${label}`);
  return value;
}

function quote(value) {
  return JSON.stringify(String(value));
}

function protocolModel(schema) {
  const defs = required(schema.$defs, "$defs");
  const start = required(
    defs.startRequest?.properties,
    "$defs.startRequest.properties",
  );
  const response = required(
    defs.response?.properties,
    "$defs.response.properties",
  );
  const error = required(
    response.error?.properties,
    "$defs.response.properties.error.properties",
  );
  const states = required(response.state?.enum, "response state registry");
  if (
    !Array.isArray(states) ||
    states.some((value) => typeof value !== "string")
  ) {
    throw new Error("runtime supervisor state registry must be a string array");
  }
  return {
    protocol: String(required(defs.protocol?.const, "$defs.protocol.const")),
    readyFrame: String(
      required(defs.readyFrame?.const, "$defs.readyFrame.const"),
    ),
    maxFrameBytes: integer(
      defs.maxFrameBytes?.const,
      "$defs.maxFrameBytes.const",
    ),
    requestIdMax: integer(
      defs.requestId?.maxLength,
      "$defs.requestId.maxLength",
    ),
    extensionIdMax: integer(
      defs.extensionId?.maxLength,
      "$defs.extensionId.maxLength",
    ),
    programMax: integer(
      start.program?.maxLength,
      "startRequest.program.maxLength",
    ),
    argsMax: integer(start.args?.maxItems, "startRequest.args.maxItems"),
    argumentMax: integer(
      start.args?.items?.maxLength,
      "startRequest.args.items.maxLength",
    ),
    environmentKeysMax: integer(
      start.env?.maxProperties,
      "startRequest.env.maxProperties",
    ),
    environmentValueMax: integer(
      start.env?.additionalProperties?.maxLength,
      "startRequest.env value maxLength",
    ),
    timeoutMax: integer(
      start.startup_timeout_ms?.maximum,
      "startRequest.startup_timeout_ms.maximum",
    ),
    errorCodeMax: integer(
      error.code?.maxLength,
      "response.error.code.maxLength",
    ),
    errorMessageMax: integer(
      error.message?.maxLength,
      "response.error.message.maxLength",
    ),
    states,
    responseKeys: Object.keys(response),
  };
}

function renderTypescript(model) {
  const states = `[${model.states.map(quote).join(", ")}]`;
  const responseKeys = `[${model.responseKeys.map(quote).join(", ")}]`;
  return `// Generated from contracts/runtime-supervisor.schema.json. Do not edit.\n\nexport const RUST_SUPERVISOR_PROTOCOL_VERSION = ${quote(model.protocol)} as const;\nexport const EXTENSION_READY_FRAME = ${quote(model.readyFrame)} as const;\nexport const RUST_SUPERVISOR_LIMITS = Object.freeze({\n  maxFrameBytes: ${model.maxFrameBytes},\n  requestIdMax: ${model.requestIdMax},\n  extensionIdMax: ${model.extensionIdMax},\n  programMax: ${model.programMax},\n  argsMax: ${model.argsMax},\n  argumentMax: ${model.argumentMax},\n  environmentKeysMax: ${model.environmentKeysMax},\n  environmentValueMax: ${model.environmentValueMax},\n  timeoutMax: ${model.timeoutMax},\n  errorCodeMax: ${model.errorCodeMax},\n  errorMessageMax: ${model.errorMessageMax},\n});\nexport const SUPERVISOR_STATES = ${states} as const;\nexport const SUPERVISOR_RESPONSE_KEYS = ${responseKeys} as const;\n\nexport type SupervisorState = (typeof SUPERVISOR_STATES)[number];\nexport type SupervisorError = { code: string; message: string };\nexport type SupervisorStartRequest = {\n  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;\n  request_id: string;\n  op: "start";\n  extension_id: string;\n  program: string;\n  args: string[];\n  env: Record<string, string>;\n  startup_timeout_ms: number;\n  shutdown_grace_ms: number;\n};\nexport type SupervisorHealthRequest = {\n  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;\n  request_id: string;\n  op: "health";\n};\nexport type SupervisorStopRequest = {\n  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;\n  request_id: string;\n  op: "stop";\n};\nexport type SupervisorRequest = SupervisorStartRequest | SupervisorHealthRequest | SupervisorStopRequest;\nexport type SupervisorResponse = {\n  protocol: typeof RUST_SUPERVISOR_PROTOCOL_VERSION;\n  request_id: string;\n  ok: boolean;\n  state: SupervisorState;\n  ready?: boolean;\n  child_pid?: number;\n  forced?: boolean;\n  exit_code?: number;\n  signal?: number;\n  error?: SupervisorError;\n};\n`;
}

function renderRust(model) {
  const variants = model.states
    .map((state) => `    ${state[0].toUpperCase()}${state.slice(1)},`)
    .join("\n");
  return `// Generated from contracts/runtime-supervisor.schema.json. Do not edit.\n\nuse serde::{Deserialize, Serialize};\nuse std::collections::BTreeMap;\n\npub const PROTOCOL_VERSION: &str = ${quote(model.protocol)};\npub const EXTENSION_READY_FRAME: &[u8] = ${quote(model.readyFrame)}.as_bytes();\npub const MAX_FRAME_BYTES: usize = ${model.maxFrameBytes};\npub const MAX_REQUEST_ID_BYTES: usize = ${model.requestIdMax};\npub const MAX_EXTENSION_ID_BYTES: usize = ${model.extensionIdMax};\npub const MAX_PROGRAM_BYTES: usize = ${model.programMax};\npub const MAX_ARGUMENTS: usize = ${model.argsMax};\npub const MAX_ARGUMENT_BYTES: usize = ${model.argumentMax};\npub const MAX_ENVIRONMENT_KEYS: usize = ${model.environmentKeysMax};\npub const MAX_ENVIRONMENT_VALUE_BYTES: usize = ${model.environmentValueMax};\npub const MAX_GRACE_MS: u64 = ${model.timeoutMax};\npub const MAX_ERROR_MESSAGE_BYTES: usize = ${model.errorMessageMax};\n\n#[derive(Debug, Deserialize)]\n#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]\npub enum Request {\n    Start {\n        protocol: String,\n        request_id: String,\n        extension_id: String,\n        program: String,\n        args: Vec<String>,\n        env: BTreeMap<String, String>,\n        startup_timeout_ms: u64,\n        shutdown_grace_ms: u64,\n    },\n    Health {\n        protocol: String,\n        request_id: String,\n    },\n    Stop {\n        protocol: String,\n        request_id: String,\n    },\n}\n\nimpl Request {\n    pub(crate) fn request_id(&self) -> &str {\n        match self {\n            Self::Start { request_id, .. }\n            | Self::Health { request_id, .. }\n            | Self::Stop { request_id, .. } => request_id,\n        }\n    }\n\n    pub(crate) fn protocol(&self) -> &str {\n        match self {\n            Self::Start { protocol, .. }\n            | Self::Health { protocol, .. }\n            | Self::Stop { protocol, .. } => protocol,\n        }\n    }\n}\n\n#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]\n#[serde(rename_all = "snake_case")]\npub enum SupervisorState {\n    #[default]\n${variants}\n}\n\n#[derive(Debug, Serialize)]\npub struct ProtocolError {\n    pub(crate) code: String,\n    pub(crate) message: String,\n}\n\n#[derive(Debug, Serialize)]\npub struct Response {\n    pub(crate) protocol: &'static str,\n    pub(crate) request_id: String,\n    pub(crate) ok: bool,\n    pub(crate) state: SupervisorState,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) ready: Option<bool>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) child_pid: Option<u32>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) forced: Option<bool>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) exit_code: Option<i32>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) signal: Option<i32>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) error: Option<ProtocolError>,\n}\n`;
}

export async function generateRuntimeSupervisorProtocol({
  outputRoot = ".",
} = {}) {
  const schema = JSON.parse(await readFile(sourcePath, "utf8"));
  const model = protocolModel(schema);
  const outputs = new Map([
    [
      "src/extensions/generated/runtime-supervisor-protocol.ts",
      await format(renderTypescript(model), { parser: "typescript" }),
    ],
    ["crates/runtime-supervisor/src/generated/protocol.rs", renderRust(model)],
  ]);
  for (const [path, content] of outputs) {
    const destination = join(outputRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return [...outputs.keys()];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const files = await generateRuntimeSupervisorProtocol({
    outputRoot: process.env.PROTOCOL_OUTPUT_ROOT ?? ".",
  });
  console.log(`runtime supervisor protocol generated: ${files.join(", ")}`);
}
