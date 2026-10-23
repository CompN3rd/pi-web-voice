import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { externalPath, speechCacheName, speechManifest, validAsset } from "../scripts/speech-assets.mjs";
import { ttsBrowserHarness } from "./tts-runtime-browser-support.mjs";

// Separately invoked actual-model smoke. The only source is the operator's
// explicitly supplied external PIVOTTS1 pack. Never discover or fetch weights.
const filename = process.env.VOICE_TTS_PACK_FILE;
if (!filename) throw new Error("NOT RUN: set VOICE_TTS_PACK_FILE to an explicitly supplied external verified TTS .pivoice pack. No default downloads.");
const path = await externalPath(filename);
const assets = await speechManifest("tts");
const expected = assets.reduce((sum, asset) => sum + asset.bytes, 8);
assert.equal((await stat(path)).size, expected, "exact compiled pack size before allocation");
const bytes = await readFile(path);
assert.equal(bytes.subarray(0, 8).toString(), "PIVOTTS1");
let offset = 8;
for (const asset of assets) {
  assert.ok(validAsset(bytes.subarray(offset, offset + asset.bytes), asset), `Pinned integrity: ${asset.path}`);
  offset += asset.bytes;
}
const harness = await ttsBrowserHarness({ assets, cache: speechCacheName("tts", assets) });
try {
  const { context, page, unexpected } = await harness.context(bytes);
  try {
    const results = await page.evaluate(async () => {
      const { WorkerTtsRuntime } = await import("/nested/voice/tts-runtime.js");
      const stats = [];
      const create = () => new WorkerTtsRuntime({ worker: () => {
        const worker = new Worker("/nested/voice/instrument.js", { type: "module", name: "actual-model" });
        worker.addEventListener("message", ({ data }) => { if (data.stats) stats.push(data.stats); });
        return worker;
      } });
      const outputs = [];
      let runtime = create();
      try {
        await runtime.prepare(() => {}, { source: "import", file: document.querySelector("input").files[0] });
        for (const text of ["Hello world. This is local English speech.", "Hello world. ".repeat(60), "antidisestablishmentarianism ".repeat(25).trim()]) {
          const chunkCount = await runtime.plan(text);
          if (text.length > 500 && chunkCount < 2) throw Error("Actual tokenizer did not exercise multi-chunk preflight");
          let samples = 0;
          for (let i = 0; i < chunkCount; i++) {
            const pcm = await runtime.chunk(i);
            if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > 720000 || pcm.some(v => !Number.isFinite(v) || Math.abs(v) > 1)) throw Error("Invalid PCM");
            samples += pcm.length;
          }
          if (samples > 2880000) throw Error("Total PCM ceiling");
          outputs.push({ chunkCount, samples, sampleRate: 24000 });
        }
        await runtime.plan("Cancel this pending synthesis.");
        const pending = runtime.chunk(0);
        runtime.terminate();
        if (await pending.then(() => false, () => true) !== true) throw Error("Cancellation did not reject pending synthesis");
        runtime = create();
        await runtime.prepare(() => {}, { source: "cache" });
        await runtime.plan("Explicit preparation after cancellation.");
        const pcm = await runtime.chunk(0);
        if (!pcm.length) throw Error("Reprepared model returned no audio");
        outputs.push({ reprepared: true, samples: pcm.length, sampleRate: 24000 });
      } finally { runtime.terminate(); }
      return { outputs, stats };
    });
    assert.deepEqual(unexpected, []);
    for (const stats of results.stats) {
      assert.equal(stats.nativeFetch, 0); assert.equal(stats.nativeXhr, 0); assert.equal(stats.unexpectedFetch, 0); assert.equal(stats.guardedTransports, 0);
    }
    assert.ok(results.stats.length > 0);
    console.log(`PASS actual pinned TTS PCM smoke (not intelligibility/Pixel acceptance): ${JSON.stringify(results.outputs)}`);
  } finally { await context.close(); }
} finally { await harness.close(); }
