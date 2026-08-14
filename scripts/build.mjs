import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
const runtimePackage = {
  name: packageMetadata.name,
  version: packageMetadata.version,
  private: true,
  description: packageMetadata.description,
  type: "module",
  engines: packageMetadata.engines,
  license: packageMetadata.license,
  scripts: { start: "node src/server.mjs" },
};
const runtimeSources = [
  "src/contracts.mjs",
  "src/providers.mjs",
  "src/server.mjs",
  "src/store.mjs",
];

await rm("dist", { recursive: true, force: true });
await mkdir("dist/src", { recursive: true });
await cp("contracts", "dist/contracts", { recursive: true });
await cp("LICENSE", "dist/LICENSE");
for (const source of runtimeSources) {
  await cp(source, `dist/${source}`);
}
await writeFile(
  "dist/package.json",
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
);

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else files.push(path.replaceAll("\\", "/"));
  }
}

await walk("dist");
const sortedFiles = files.sort();
const fileHashes = [];
for (const file of sortedFiles) {
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  fileHashes.push(`${digest}  ${file}`);
}
const manifest = {
  artifact: packageMetadata.name,
  version: packageMetadata.version,
  files: sortedFiles,
  sha256: createHash("sha256").update(fileHashes.join("\n")).digest("hex"),
  file_hashes: fileHashes,
  reproducible: true,
};
await writeFile(
  "dist/BUILD-MANIFEST.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`build passed: ${files.length} runtime files staged in dist/`);
