import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { speechPackKind } from "../src/browser/speech-pack-kind.ts";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeFiles = [
  { path: "ort-wasm-simd-threaded.jsep.mjs", bytes: 44484, sha256: "08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9" },
  { path: "ort-wasm-simd-threaded.jsep.wasm", bytes: 21596019, sha256: "c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39" },
];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const validAsset = (bytes, asset) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
export const pack = JSON.parse(await readFile(new URL("./speech-pack.json", import.meta.url), "utf8"));

const ttsPack = JSON.parse(await readFile(new URL("./tts-pack.json", import.meta.url), "utf8"));
export function speechPack(kind = "recognition") { return speechPackKind(kind) === "tts" ? ttsPack : pack; }
export function speechCacheName(kind, assets) {
  const prefix = speechPackKind(kind) === "tts" ? "pi-voice-tts" : "pi-voice-speech";
  return `${prefix}-${sha256(JSON.stringify(assets)).slice(0, 24)}`;
}

export async function speechManifest(kind = "recognition") {
  const selected = speechPack(kind);
  for (const [name, version] of [["onnxruntime-web", selected.onnxRuntime], ["@huggingface/transformers", selected.transformers]]) {
    const metadata = JSON.parse(await readFile(join(packageRoot, "node_modules", name, "package.json"), "utf8"));
    if (metadata.version !== version) throw new Error("Speech runtime dependency pin mismatch");
  }
  const assets = selected.files.filter(file => file.path !== "README.md").map(file => ({
    ...file, path: `models/${selected.model}/${file.path}`,
    downloadUrl: `https://huggingface.co/${selected.model}/resolve/${selected.revision}/${file.path}`,
  }));
  if (kind === "tts") {
    const { path, bytes, sha256, downloadUrl } = selected.phonemizer;
    assets.push({ path, bytes, sha256, downloadUrl });
  }
  for (const file of runtimeFiles) {
    const bytes = await readFile(join(packageRoot, "node_modules/onnxruntime-web/dist", file.path));
    if (!validAsset(bytes, file)) throw new Error(`Speech runtime integrity failure: ${file.path}`);
    assets.push({ ...file, path: `ort/${file.path}`, downloadUrl: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${selected.onnxRuntime}/dist/${file.path}` });
  }
  return assets;
}

export async function copySpeechNotices(output, kind = "recognition") {
  speechPackKind(kind);
  await mkdir(join(output, "ort"), { recursive: true });
  await copyFile(join(packageRoot, "scripts/speech-licenses/ONNXRUNTIME-LICENSE"), join(output, "ort/LICENSE"));
  await copyFile(join(packageRoot, "node_modules/@huggingface/transformers/LICENSE"), join(output, "TRANSFORMERS-LICENSE"));
  await copyFile(join(packageRoot, kind === "tts" ? "scripts/tts-pack.json" : "scripts/speech-pack.json"), join(output, "speech-pack-provenance.json"));
  if (kind === "tts") {
    for (const name of ["PHONEMIZER-LICENSE", "KOKORO-JS-LICENSE", "ESPEAK-NG-COPYING", "TTS-NOTICE.txt"]) {
      await copyFile(join(packageRoot, "scripts/speech-licenses", name), join(output, name));
    }
    await copyFile(join(packageRoot, "docs/tts-qualification.md"), join(output, "TTS-QUALIFICATION.md"));
  }
}

const within = (root, path) => {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
};

// Resolve existing ancestors as well as the final directory: a symlink followed
// by not-yet-created children must not redirect provisioning into the package.
export async function externalPath(path, root = packageRoot) {
  if (!path || !isAbsolute(path)) throw new Error("Speech path must be absolute and outside the package/repository root");
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
  return output;
}

export async function externalOutput(path, root = packageRoot) {
  const output = await externalPath(path, root);
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
