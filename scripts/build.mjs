import { mkdir, cp, writeFile, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

await rm("dist", { recursive: true, force: true }); await mkdir("dist", { recursive: true });
for (const file of ["package.json", "LICENSE"]) await cp(file, `dist/${file}`);
await cp("src", "dist/src", { recursive: true }); await cp("contracts", "dist/contracts", { recursive: true });
const files = [];
async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) await walk(p); else files.push(p.replaceAll("\\", "/")); } }
await walk("dist");
const sortedFiles = files.sort();
const fileHashes = []; for (const file of sortedFiles) fileHashes.push(`${createHash("sha256").update(await readFile(file)).digest("hex")}  ${file}`);
const manifest = { artifact: "sumi-agentic-voice-crm", version: JSON.parse(await readFile("package.json", "utf8")).version, files: sortedFiles, sha256: createHash("sha256").update(fileHashes.join("\n")).digest("hex"), file_hashes: fileHashes, reproducible: true };
await writeFile("dist/BUILD-MANIFEST.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`build passed: ${files.length} files staged in dist/`);
