export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  return value;
}
