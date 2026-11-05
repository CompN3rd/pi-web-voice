import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { externalPath, sha256, speechCacheName, speechManifest, validAsset } from "../scripts/speech-assets.mjs";
import { ttsBrowserHarness } from "./tts-runtime-browser-support.mjs";

// Separately invoked actual-model smoke. The only source is the operator's
// explicitly supplied external PIVOTTS1 pack. Never discover or fetch weights.
const filename = process.env.VOICE_TTS_PACK_FILE;
if (!filename) throw new Error("NOT RUN: set VOICE_TTS_PACK_FILE to an explicitly supplied external verified TTS .pivoice pack. No default downloads.");
const path = await externalPath(filename);
const syntheticOutput = process.env.VOICE_TTS_SYNTHETIC_OUTPUT ? await externalPath(process.env.VOICE_TTS_SYNTHETIC_OUTPUT) : undefined;
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
  const { context, page, unexpected } = await harness.context(path);
  try {
    await page.exposeFunction("reportTtsModel", result => console.log(`TTS model checkpoint: ${JSON.stringify(result)}`));
    if (syntheticOutput) await page.exposeFunction("saveSyntheticSpeech", async fixture => {
      // Fixed test sentence only, never microphone/user audio. Explicit external
      // output is opt-in and exclusive: no overwriting an operator's files.
      assert.equal(fixture.text, "Hello world. This is local English speech.");
      const serialized = JSON.stringify({ kind: "synthetic-kokoro-test-v1", packSha256: sha256(bytes), ...fixture });
      await writeFile(syntheticOutput, serialized, { flag: "wx", mode: 0o600 });
      console.log(`Synthetic speech fixture: ${syntheticOutput}; SHA256 ${sha256(serialized)}`);
    });
    const results = await page.evaluate(async ({ saveSynthetic }) => {
      const { WorkerTtsRuntime } = await import("/nested/voice/tts-runtime.js");
      const stats = [];
      const create = () => new WorkerTtsRuntime({ worker: () => {
        const worker = new Worker("/nested/voice/instrument.js", { type: "module", name: "actual-model" });
        worker.addEventListener("message", ({ data }) => { if (data.stats) stats.push(data.stats); });
        return worker;
      } });
      const outputs = [];
      const start = performance.now();
      let runtime = create();
      const report = async value => { outputs.push(value); await window.reportTtsModel(value); };
      const checkPcm = pcm => {
        if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > 720000 || pcm.some(v => !Number.isFinite(v) || Math.abs(v) > 1)
          || !pcm.some(v => Math.abs(v) > 0.001)) throw Error("Invalid or silent PCM");
      };
      const prepare = async source => {
        const started = performance.now();
        await runtime.prepare(() => {}, source === "import" ? { source, file: document.querySelector("input").files[0] } : { source });
        await report({ prepared: source, elapsedMs: Math.round(performance.now() - started) });
      };
      try {
        await prepare("import");
        for (const [index, text] of ["Hello world. This is local English speech.", "Hello world. ".repeat(12)].entries()) {
          const synthesisStart = performance.now();
          const chunkCount = await runtime.plan(text);
          if (index === 1 && chunkCount < 2) throw Error("Actual tokenizer did not exercise multi-chunk preflight");
          let samples = 0;
          for (let i = 0; i < chunkCount; i++) {
            const pcm = await runtime.chunk(i);
            checkPcm(pcm);
            samples += pcm.length;
            if (saveSynthetic && index === 0) {
              if (chunkCount !== 1) throw Error("Synthetic fixture must be one complete sentence");
              await window.saveSyntheticSpeech({ text, sampleRate: 24000, pcm: Array.from(pcm) });
            }
          }
          if (samples > 2880000) throw Error("Total PCM ceiling");
          await report({ scenario: index === 0 ? "short" : "multi-chunk", chunkCount, samples, sampleRate: 24000, elapsedMs: Math.round(performance.now() - synthesisStart) });
        }
        await runtime.plan("Cancel this pending synthesis.");
        const pending = runtime.chunk(0);
        runtime.terminate();
        if (await pending.then(() => false, () => true) !== true) throw Error("Cancellation did not reject pending synthesis");
        runtime = create();
        await prepare("cache");
        await runtime.plan("Explicit preparation after cancellation.");
        const synthesisStart = performance.now();
        const pcm = await runtime.chunk(0);
        checkPcm(pcm);
        await report({ scenario: "reprepared", samples: pcm.length, sampleRate: 24000, elapsedMs: Math.round(performance.now() - synthesisStart) });

        // Retain the original long fixtures as bounded stress checks, not a claim
        // that this CPU can finish them. Short/multi-chunk success above is mandatory.
        for (const [index, text] of ["Hello world. ".repeat(60), "antidisestablishmentarianism ".repeat(25).trim()].entries()) {
          const started = performance.now();
          const chunkCount = await runtime.plan(text);
          if (chunkCount < 2) throw Error("Long fixture did not split");
          let samples = 0;
          let completedChunks = 0;
          let outcome = "completed";
          try {
            for (let i = 0; i < chunkCount; i++) {
              const pcm = await runtime.chunk(i);
              checkPcm(pcm); samples += pcm.length; completedChunks++;
              if (samples > 2880000) throw Error("Total PCM ceiling");
            }
          } catch (error) {
            if (error.message !== "TTS timeout; explicitly prepare again") throw error;
            outcome = "timeout-fail-closed";
            // A timed-out runtime must not deliver more audio or silently restart.
            for (const operation of [() => runtime.chunk(completedChunks), () => runtime.plan("No automatic restart.")]) {
              const message = await operation().then(() => "unexpected success", error => error.message);
              if (message !== "TTS not-ready; explicitly prepare again") throw Error(message);
            }
          }
          const elapsedMs = Math.round(performance.now() - started);
          if (elapsedMs > 310000) throw Error("Long fixture exceeded bounded job deadline plus test scheduling tolerance");
          await report({ scenario: `long-${index + 1}`, outcome, chunkCount, completedChunks, samples, sampleRate: 24000, elapsedMs });
          runtime.terminate();
          if (index === 0) { runtime = create(); await prepare("cache"); }
        }
      } finally { runtime.terminate(); }
      return { outputs, stats, elapsedMs: Math.round(performance.now() - start) };
    }, { saveSynthetic: Boolean(syntheticOutput) });
    assert.deepEqual(unexpected, []);
    for (const stats of results.stats) {
      assert.equal(stats.nativeFetch, 0); assert.equal(stats.nativeXhr, 0); assert.equal(stats.unexpectedFetch, 0); assert.equal(stats.guardedTransports, 0);
    }
    assert.ok(results.stats.length > 0);
    console.log(`PASS actual pinned TTS PCM and bounded-stress checks (not intelligibility/Pixel acceptance): ${JSON.stringify({ outputs: results.outputs, elapsedMs: results.elapsedMs })}`);
  } finally { await context.close(); }
} finally { await harness.close(); }
