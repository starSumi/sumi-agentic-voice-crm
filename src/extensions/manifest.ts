export const EXTENSION_PROTOCOL_VERSION = "sumi.runtime.extension.v1";

export const EXTENSION_CAPABILITIES = Object.freeze([
  "runtime.health",
  "provider.asr",
  "provider.intent",
  "provider.tts",
  "tool.crm.read",
  "tool.crm.write",
  "transport.http",
  "transport.sse",
  "transport.mcp",
  "storage.object",
  "observability.trace",
]);

export const EXTENSION_PERMISSIONS = Object.freeze([
  "network.provider",
  "crm.read",
  "crm.write",
  "media.read",
  "media.write",
  "telemetry.write",
  "transport.serve",
]);

const CAPABILITY_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "runtime.health": [],
  "provider.asr": ["network.provider", "media.read"],
  "provider.intent": ["network.provider"],
  "provider.tts": ["network.provider", "media.write"],
  "tool.crm.read": ["crm.read"],
  "tool.crm.write": ["crm.write"],
  "transport.http": ["transport.serve"],
  "transport.sse": ["transport.serve"],
  "transport.mcp": ["transport.serve"],
  "storage.object": ["media.read", "media.write"],
  "observability.trace": ["telemetry.write"],
});

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const allowedKeys = new Set([
  "schema_version",
  "id",
  "version",
  "protocol_version",
  "owner",
  "isolation",
  "entrypoint",
  "capabilities",
  "permissions",
  "dependencies",
]);

type StringArrayOptions = { allow?: ReadonlySet<string>; allowEmpty?: boolean };
export type ExtensionManifest = Readonly<{
  schema_version: "sumi.extension-manifest.v1";
  id: string;
  version: string;
  protocol_version: typeof EXTENSION_PROTOCOL_VERSION;
  owner: string;
  isolation: "in-process" | "process";
  entrypoint: string;
  capabilities: readonly string[];
  permissions: readonly string[];
  dependencies: readonly string[];
  [key: string]: unknown;
}>;

function strings(value: unknown, name: string, { allow = undefined, allowEmpty = false }: StringArrayOptions = {}): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new TypeError(`${name} must not contain duplicates`);
  if (allow && unique.some((entry) => !allow.has(entry))) throw new TypeError(`${name} contains an unsupported value`);
  return unique;
}

function freeze(value: unknown): unknown {
  if (Array.isArray(value)) for (const entry of value) freeze(entry);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) freeze(entry);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

export function validateExtensionManifest(input: unknown): ExtensionManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("extension manifest must be an object");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new TypeError("extension manifest contains an unknown field");
  if (record.schema_version !== "sumi.extension-manifest.v1") throw new TypeError("unsupported extension manifest schema_version");
  if (typeof record.id !== "string" || !ID.test(record.id) || record.id.length > 128) throw new TypeError("extension id is invalid");
  if (typeof record.version !== "string" || !VERSION.test(record.version)) throw new TypeError("extension version must be exact semver");
  if (record.protocol_version !== EXTENSION_PROTOCOL_VERSION) throw new TypeError("extension protocol version is incompatible");
  if (typeof record.owner !== "string" || !record.owner.trim() || record.owner.length > 128) throw new TypeError("extension owner is required");
  if (record.isolation !== "in-process" && record.isolation !== "process") throw new TypeError("extension isolation must be in-process or process");
  if (typeof record.entrypoint !== "string" || !record.entrypoint || record.entrypoint.length > 256 || record.entrypoint.includes("\0")) {
    throw new TypeError("extension entrypoint is invalid");
  }
  const capabilities = strings(record.capabilities, "extension capabilities", { allow: new Set(EXTENSION_CAPABILITIES) });
  const permissions = strings(record.permissions, "extension permissions", {
    allow: new Set(EXTENSION_PERMISSIONS),
    allowEmpty: true,
  });
  for (const capability of capabilities) {
    for (const required of CAPABILITY_PERMISSIONS[capability]) {
      if (!permissions.includes(required)) throw new TypeError(`extension capability ${capability} requires permission ${required}`);
    }
  }
  const dependencies = record.dependencies === undefined
    ? []
    : strings(record.dependencies, "extension dependencies", { allowEmpty: true });
  if (dependencies.some((id) => !ID.test(id) || id === record.id)) throw new TypeError("extension dependencies contain an invalid id");
  return freeze(structuredClone({
    ...record,
    owner: (record.owner as string).trim(),
    capabilities,
    permissions,
    dependencies,
  })) as ExtensionManifest;
}
