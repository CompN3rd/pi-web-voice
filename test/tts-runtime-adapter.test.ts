import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import type { TtsLoader } from "../src/browser/tts-loader.js";

const sink = { inputs: [] as { ids: bigint[]; style: number; speed: number; dims: number[] }[], disposed: 0, waveform: new Float32Array([0, .1, -.1]) };
(globalThis as unknown as { ttsAdapterTest: typeof sink }).ttsAdapterTest = sink;
const fakeTransformers = `
export const env = { backends: { onnx: { wasm: {} } } };
export class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  dispose() { globalThis.ttsAdapterTest.disposed++; }
}
export const AutoTokenizer = { async from_pretrained(name, options) {
  if (!options.local_files_only || name !== "onnx-community/Kokoro-82M-v1.0-ONNX") throw Error("model pin");
  return { model_max_length: 512,
    encode(text, { add_special_tokens }) { const ids = Array.from(text, c => c.codePointAt(0)); return add_special_tokens ? [0, ...ids, 0] : ids; },
    decode(ids) { return String.fromCodePoint(...ids); }
  };
} };
export const StyleTextToSpeech2Model = { async from_pretrained(name, options) {
  if (options.device !== "wasm" || options.dtype !== "q8" || !options.local_files_only || env.allowRemoteModels !== false || env.useBrowserCache !== false || env.backends.onnx.wasm.numThreads !== 1 || env.backends.onnx.wasm.proxy !== false) throw Error("runtime configuration");
  return async ({ input_ids, style, speed }) => {
    globalThis.ttsAdapterTest.inputs.push({ ids: Array.from(input_ids.data), style: style.data[0], speed: speed.data[0], dims: input_ids.dims });
    const pcm = globalThis.ttsAdapterTest.waveform;
    return { waveform: new Tensor("float32", pcm, [1, pcm.length]) };
  };
} };
`;
const bundle = await build({ entryPoints: ["src/browser/tts-adapter.ts"], bundle: true, write: false, format: "esm", platform: "browser", plugins: [{ name: "fake-transformers", setup(build) {
  build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: "fake", namespace: "tts" }));
  build.onLoad({ filter: /.*/, namespace: "tts" }, () => ({ contents: fakeTransformers, loader: "js" }));
} }] });
const { TtsModelAdapter } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as typeof import("../src/browser/tts-adapter.js");
function loader(): TtsLoader {
  const voice = new Float32Array(510 * 256);
  for (let i = 0; i < voice.length; i++) voice[i] = Math.floor(i / 256);
  return {
    base: new URL("https://example.test/nested/tts-cache/"), ortModuleUrl: "blob:verified", dispose() {},
    phonemize: async text => [text],
    fetch: async input => { assert.equal(String(input), "https://example.test/nested/tts-cache/models/onnx-community/Kokoro-82M-v1.0-ONNX/voices/af_heart.bin"); return new Response(voice.buffer); },
  };
}

test("tts-adapter: explicit voice, fixed speed, exact token inputs and all-prefix preflight before synthesis", async () => {
  sink.inputs = []; sink.disposed = 0;
  const adapter = await TtsModelAdapter.create(loader());
  assert.equal(await adapter.plan("a ".repeat(254) + "aa"), 1);
  assert.equal(sink.inputs.length, 0);
  const pcm = await adapter.chunk(0);
  assert.ok(pcm instanceof Float32Array); assert.notEqual(pcm, sink.waveform);
  assert.equal(sink.inputs[0].ids.length, 512); assert.equal(sink.inputs[0].style, 509); assert.equal(sink.inputs[0].speed, 1);
  assert.deepEqual(sink.inputs[0].dims, [1, 512]); assert.equal(sink.disposed, 4);
  assert.equal(await adapter.plan("a ".repeat(499) + "aa"), 2);
  await adapter.chunk(0); await adapter.chunk(1);
  assert.equal(sink.inputs.slice(1).reduce((sum, input) => sum + input.ids.length - 2, 0), 1000);
});

test("tts-adapter: unsupported later spans, malformed voice, out-of-order chunks and invalid PCM reject", async () => {
  const bad = loader(); bad.fetch = async () => new Response(new Uint8Array([0]));
  await assert.rejects(TtsModelAdapter.create(bad), /TTS prepare/);
  const nan = loader(); nan.fetch = async () => { const voice = new Float32Array(510 * 256); voice[1] = NaN; return new Response(voice.buffer); };
  await assert.rejects(TtsModelAdapter.create(nan), /TTS prepare/);
  const adapter = await TtsModelAdapter.create(loader());
  const count = sink.inputs.length;
  await assert.rejects(adapter.plan("Hello 😀"), /TTS text/); assert.equal(sink.inputs.length, count);
  await adapter.plan("Hello"); await assert.rejects(adapter.chunk(1), /TTS synthesis/);
  sink.waveform = new Float32Array([NaN]);
  try { await assert.rejects(adapter.chunk(0), /TTS synthesis/); } finally { sink.waveform = new Float32Array([0, .1, -.1]); }
});
