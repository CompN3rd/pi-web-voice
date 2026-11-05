import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { speechManifest, validAsset } from "../scripts/speech-assets.mjs";
import { ttsPhonemizerInput } from "./tts-phonemizer-input.mjs";
import { ttsBrowserHarness } from "./tts-runtime-browser-support.mjs";

// The candidate is test-only import/cache input with NO download URL. Neither
// compiled production inventory nor distribution policy is changed by this test.
const phonemizer = await ttsPhonemizerInput();
const manifest = await speechManifest("tts");
const assets = [phonemizer.asset, ...manifest.filter(asset => asset.path.startsWith("ort/"))];
const parts = [Buffer.from("PIVOTTS1")];
for (const asset of assets) {
  const bytes = asset.path.startsWith("phonemizer/") ? phonemizer.bytes : await readFile(`node_modules/onnxruntime-web/dist/${asset.path.slice(4)}`);
  assert.ok(validAsset(bytes, asset), `Pinned integrity: ${asset.path}`); parts.push(bytes);
}
const modelAdapter = `
  export class TtsModelAdapter {
    static async create(loader) {
      globalThis.ttsStats ??= { phonemizerCalls: 0, ortInit: null };
      const phonemes = await loader.phonemize("Hello world.", "en-us");
      globalThis.ttsStats.phonemizerCalls++;
      if (!Array.isArray(phonemes) || !phonemes.join("").trim()) throw Error("phonemizer empty");
      const { default: factory } = await import(loader.ortModuleUrl);
      const module = await factory({ numThreads: 1, locateFile: () => new URL("ort/ort-wasm-simd-threaded.jsep.wasm", loader.base).href });
      globalThis.ttsStats.ortInit = module._OrtInit(1, 2);
      if (globalThis.ttsStats.ortInit !== 0) throw Error("ORT init");
      return new TtsModelAdapter();
    }
    async plan(text) { return 2; }
    async chunk(index) { return new Float32Array([0, 0.1, -0.1]); }
  }
`;
const harness = await ttsBrowserHarness({ assets, cache: "pi-voice-tts-loader-test", modelAdapter });
try {
  for (const scenario of ["cached", "phonemizer-evicted", "phonemizer-corrupt", "wasm-evicted", "wasm-corrupt", "no-decompression", "no-blob-stream", "no-pipe-through", "no-async-iteration", "no-webassembly"]) {
    const { context, page, unexpected } = await harness.context(Buffer.concat(parts));
    try {
      const prepare = source => page.evaluate(({ scenario, source }) => new Promise((resolve, reject) => {
        const worker = new Worker("/nested/voice/instrument.js", { type: "module", name: scenario });
        const timer = setTimeout(() => { worker.terminate(); reject(Error("TTS loader timeout")); }, 60_000);
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(Error(event.message)); };
        worker.onmessage = ({ data }) => {
          if (data.type === "loaded") worker.postMessage({ version: 1, pack: "pi-voice-tts-loader-test", build: "tts-browser-test-v1", instance: "loader-test", id: 1, type: "prepare", options: source === "import" ? { source, file: document.querySelector("input").files[0] } : { source } });
          else if (data.type !== "progress") { clearTimeout(timer); worker.terminate(); resolve(data); }
        };
      }), { scenario, source });
      const missing = await prepare("cache");
      assert.equal(missing.type, "error"); assert.equal(missing.code, "prepare"); assert.equal(missing.stats.prepared, false);
      const result = await prepare("import");
      const unsupported = scenario === "no-webassembly";
      assert.equal(result.stats.prepared, !unsupported);
      assert.equal(result.stats.nativeFetch, 0); assert.equal(result.stats.nativeXhr, 0); assert.equal(result.stats.unexpectedFetch, 0);
      assert.deepEqual(unexpected, []);
      if (unsupported) {
        assert.equal(result.type, "error"); assert.equal(result.code, "prepare");
        assert.equal(result.stats.phonemizerCalls, 0); assert.equal(result.stats.ortInit, null); assert.equal(result.stats.guardedTransports, 0);
      } else if (scenario === "cached" || scenario.startsWith("no-")) {
        assert.equal(result.type, "ready", JSON.stringify(result));
        assert.equal(result.stats.phonemizerCalls, 1); assert.equal(result.stats.ortInit, 0); assert.equal(result.stats.guardedTransports, 0);
        const reused = await prepare("cache"); assert.equal(reused.type, "ready"); assert.equal(reused.stats.nativeFetch, 0);
        // Real runtime posts prepare immediately, before dynamic bootstrap has
        // evaluated its worker module. This catches lost startup messages.
        const chunks = await page.evaluate(async () => {
          const { WorkerTtsRuntime } = await import("/nested/voice/tts-runtime.js");
          const runtime = new WorkerTtsRuntime();
          try {
            await runtime.prepare(() => {});
            const count = await runtime.plan("Hello world.");
            const lengths = [];
            for (let i = 0; i < count; i++) lengths.push((await runtime.chunk(i)).length);
            return lengths;
          } finally { runtime.terminate(); }
        });
        assert.deepEqual(chunks, [3, 3]);
      } else {
        assert.equal(result.type, "error", JSON.stringify(result)); assert.equal(result.code, "prepare"); assert.equal(result.stats.ortInit, null);
        if (scenario.startsWith("phonemizer")) { assert.equal(result.stats.phonemizerCalls, 0); assert.equal(result.stats.guardedTransports, 0); }
        else assert.equal(result.stats.guardedTransports, 1, "actual pinned ORT attempted its XHR fallback, which the guard refused");
      }
      console.log(`PASS actual pinned TTS loader (${phonemizer.candidate ? "source-built candidate" : "published"}) ${scenario}: ${JSON.stringify(result.stats)}`);
    } finally { await context.close(); }
  }
  assert.ok(!harness.requests.some(path => path.includes("tts-cache")), "no model/runtime host route");
} finally { await harness.close(); }
