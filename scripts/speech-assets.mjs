import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const runtimeNames = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const validAsset = (bytes, asset) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
export const pack = JSON.parse(await readFile(new URL("./speech-pack.json", import.meta.url), "utf8"));

export async function speechManifest() {
  for (const [name, version] of [["onnxruntime-web", pack.onnxRuntime], ["@huggingface/transformers", pack.transformers]]) {
    const metadata = JSON.parse(await readFile(join(packageRoot, "node_modules", name, "package.json"), "utf8"));
    if (metadata.version !== version) throw new Error("Speech runtime dependency pin mismatch");
  }
  const assets = pack.files.filter(file => file.path !== "README.md").map(file => ({ ...file, path: `models/${pack.model}/${file.path}` }));
  for (const name of runtimeNames) {
    const bytes = await readFile(join(packageRoot, "node_modules/onnxruntime-web/dist", name));
    assets.push({ path: `ort/${name}`, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return assets;
}

export async function copySpeechNotices(output) {
  await mkdir(join(output, "ort"), { recursive: true });
  await copyFile(join(packageRoot, "scripts/speech-licenses/ONNXRUNTIME-LICENSE"), join(output, "ort/LICENSE"));
  await copyFile(join(packageRoot, "node_modules/@huggingface/transformers/LICENSE"), join(output, "TRANSFORMERS-LICENSE"));
  await copyFile(join(packageRoot, "scripts/speech-pack.json"), join(output, "speech-pack-provenance.json"));
}

const within = (root, path) => {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
};

// Resolve existing ancestors as well as the final directory: a symlink followed
// by not-yet-created children must not redirect provisioning into the package.
export async function externalOutput(path, root = packageRoot) {
  if (!path || !isAbsolute(path)) throw new Error("--output must be an absolute directory outside the package/repository root");
  const output = resolve(path);
  const canonicalRoot = await realpath(root);
  let ancestor = output;
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  const canonicalOutput = resolve(await realpath(ancestor), relative(ancestor, output));
  if (within(resolve(root), output) || within(canonicalRoot, canonicalOutput)) throw new Error("Speech output must be outside the package/repository root");
  // Existing child links could redirect a later model/runtime write into the
  // checkout or elsewhere. Refuse them rather than overwriting their targets.
  async function rejectLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Speech output must not contain symlinks");
      if (entry.isDirectory()) await rejectLinks(join(directory, entry.name));
    }
  }
  try { await rejectLinks(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return output;
}
