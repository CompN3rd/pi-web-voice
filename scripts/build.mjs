import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";

const pack = JSON.parse(await readFile(new URL("./speech-pack.json", import.meta.url), "utf8"));
const runtimePackage = JSON.parse(await readFile("node_modules/onnxruntime-web/package.json", "utf8"));
const transformersPackage = JSON.parse(await readFile("node_modules/@huggingface/transformers/package.json", "utf8"));
if (runtimePackage.version !== pack.onnxRuntime || transformersPackage.version !== pack.transformers) throw new Error("Speech runtime dependency pin mismatch");
const assets = pack.files.filter(file => file.path !== "README.md").map(file => ({ ...file, path: `models/${pack.model}/${file.path}` }));
await mkdir("dist/browser/speech/ort", { recursive: true });
for (const name of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  const source = `node_modules/onnxruntime-web/dist/${name}`;
  const bytes = await readFile(source);
  assets.push({ path: `ort/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await copyFile(source, `dist/browser/speech/ort/${name}`);
}
// npm's pinned ORT package omits LICENSE; retained from its __commit.txt upstream revision.
await copyFile("scripts/speech-licenses/ONNXRUNTIME-LICENSE", "dist/browser/speech/ort/LICENSE");
await copyFile("node_modules/@huggingface/transformers/LICENSE", "dist/browser/speech/TRANSFORMERS-LICENSE");
await copyFile("scripts/speech-pack.json", "dist/browser/speech/speech-pack-provenance.json");
const cache = `pi-voice-speech-${createHash("sha256").update(JSON.stringify(assets)).digest("hex").slice(0, 24)}`;
const browser = { bundle: true, format: "esm", platform: "browser", target: "es2022" };
await build({ ...browser, entryPoints: ["src/browser/recognition-worker.ts"], outfile: "dist/browser/recognition-worker.js", define: { __SPEECH_ASSETS__: JSON.stringify(assets), __SPEECH_CACHE__: JSON.stringify(cache) } });
await build({ ...browser, entryPoints: ["src/browser/recognition-worklet.ts"], outfile: "dist/browser/recognition-worklet.js" });
if (process.argv.includes("--speech-only")) {
  await build({ ...browser, entryPoints: ["src/browser/audio.ts"], outfile: "dist/browser/local-recognizer.js" });
} else {
  await build({ ...browser, entryPoints: ["src/browser/index.ts"], outfile: "dist/browser/index.js" });
  await build({ entryPoints: ["src/server.ts"], outfile: "dist/server.js", bundle: true, format: "esm", platform: "node", target: "node24" });
  await build({ entryPoints: ["src/companion.ts"], outfile: "dist/companion.js", bundle: true, format: "esm", platform: "node", target: "node24", packages: "external" });
}
