import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Pinned Pi Web scans TOTAL uncompressed package bytes, not tarball size.
// This independent gate does not import or invoke private host APIs.
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export function checkInventory(files, label = "package") {
  let total = 0;
  for (const file of files) {
    if (/(^|\/)models\/|\.(?:onnx|wasm|bin|ort|pivoice)$|(^|\/)ort-wasm[^/]*\.(?:mjs|js)$|(^|\/)phonemizer\.(?:js|cjs)$/i.test(file.path)) {
      throw new Error(`${label} contains external speech payload: ${file.path}`);
    }
    total += file.size;
  }
  if (total > MAX_PACKAGE_BYTES) throw new Error(`${label} exceeds ${MAX_PACKAGE_BYTES} bytes: ${total}`);
  return total;
}

export async function checkBrowserDirectory(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Generated browser directory contains symlink: ${path}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else files.push({ path, size: (await stat(join(directory, entry.name))).size });
    }
  }
  await visit(root);
  const bytes = checkInventory(files, "generated browser directory");
  console.log(`Browser assets: ${bytes} / ${MAX_PACKAGE_BYTES} bytes; no external speech payload`);
  return bytes;
}

export function checkPackage() {
  if (!process.env.npm_execpath) throw new Error("Run the build/package gate through npm run build or npm run check:package");
  const output = execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const [result] = JSON.parse(output);
  const bytes = checkInventory(result.files);
  if (bytes !== result.unpackedSize) throw new Error("npm package inventory/unpacked size mismatch");
  console.log(`Package: ${result.files.length} files, ${bytes} / ${MAX_PACKAGE_BYTES} uncompressed bytes (tarball ${result.size} bytes); no external speech payload`);
  return bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkPackage();
