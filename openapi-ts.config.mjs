import { defineConfig } from "@hey-api/openapi-ts";
import { join } from "node:path";

const outputRoot = process.env.PROTOCOL_OUTPUT_ROOT ?? ".";

export default defineConfig({
  // The SDK consumes the just-generated JSON projection. This makes the
  // reviewed OpenAPI source -> JSON bundle -> TypeScript chain explicit and
  // ensures CI checks the same document loaded by the runtime validator.
  input: join(outputRoot, "protocol/schema/json/openapi.bundle.json"),
  output: {
    path: join(outputRoot, "packages/api-client/src/generated"),
    postProcess: ["prettier"],
  },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/typescript",
    "@hey-api/sdk",
  ],
});
