import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, env } from "@huggingface/transformers";
import { TTS_MAX_CHUNKS, TTS_MAX_TOTAL_SAMPLES, validTtsPcm } from "./tts-contract.js";
import { encodeTtsText, planTtsText, TTS_TOKEN_BUDGET } from "./tts-text.js";
import type { TtsLoader } from "./tts-loader.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Uses this project's one pinned Transformers instance. No Kokoro loader,
 * voice cache, implicit download, truncation, alternate voice or speed control.
 */
export class TtsModelAdapter {
  private chunks: number[][] = [];
  private next = 0;
  private samples = 0;
  private constructor(private readonly model: StyleTextToSpeech2Model, private readonly tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>,
    private readonly voice: Float32Array, private readonly loader: TtsLoader) {}
  static async create(loader: TtsLoader): Promise<TtsModelAdapter> {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = new URL("models/", loader.base).href;
    env.useBrowserCache = false; env.useFSCache = false; env.useFS = false; env.useCustomCache = false;
    const wasm = env.backends.onnx.wasm!;
    wasm.numThreads = 1; wasm.proxy = false; wasm.initTimeout = 60_000;
    wasm.wasmPaths = { mjs: loader.ortModuleUrl, wasm: new URL("ort/ort-wasm-simd-threaded.jsep.wasm", loader.base).href };
    const voiceBytes = await (await loader.fetch(new URL(`models/${MODEL}/voices/af_heart.bin`, loader.base))).arrayBuffer();
    if (voiceBytes.byteLength !== 510 * 256 * 4) throw new Error("TTS prepare");
    const voice = new Float32Array(510 * 256);
    const view = new DataView(voiceBytes);
    for (let i = 0; i < voice.length; i++) {
      voice[i] = view.getFloat32(i * 4, true);
      if (!Number.isFinite(voice[i])) throw new Error("TTS prepare");
    }
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { local_files_only: true });
    if (tokenizer.model_max_length !== TTS_TOKEN_BUDGET) throw new Error("TTS prepare");
    const model = await StyleTextToSpeech2Model.from_pretrained(MODEL, { device: "wasm", dtype: "q8", local_files_only: true });
    return new TtsModelAdapter(model, tokenizer, voice, loader);
  }
  async plan(text: string): Promise<number> {
    if (this.chunks.length) throw new Error("TTS busy");
    const chunks = await planTtsText(text, value => encodeTtsText(value, this.loader.phonemize, this.tokenizer));
    this.chunks = chunks.map(chunk => chunk.ids);
    this.next = 0; this.samples = 0;
    return this.chunks.length;
  }
  async chunk(index: number): Promise<Float32Array> {
    if (!Number.isSafeInteger(index) || index !== this.next || index >= this.chunks.length || this.chunks.length > TTS_MAX_CHUNKS) throw new Error("TTS synthesis");
    const ids = this.chunks[index];
    if (ids.length < 3 || ids.length > TTS_TOKEN_BUDGET) throw new Error("TTS synthesis");
    // The 510-row style table uses phoneme count, saturating its last row at
    // 509. This selects a style embedding; input_ids are never truncated.
    const styleIndex = Math.min(ids.length - 2, 509) * 256;
    const inputs = {
      input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      style: new Tensor("float32", this.voice.slice(styleIndex, styleIndex + 256), [1, 256]),
      speed: new Tensor("float32", new Float32Array([1]), [1]),
    };
    let waveform: Tensor | undefined;
    try {
      const output = await this.model(inputs);
      waveform = output.waveform as Tensor;
      if (!waveform || waveform.type !== "float32" || !validTtsPcm(waveform.data)
        || !(waveform.dims.length === 1 || (waveform.dims.length === 2 && waveform.dims[0] === 1))
        || waveform.dims.reduce((a, b) => a * b, 1) !== waveform.data.length || this.samples + waveform.data.length > TTS_MAX_TOTAL_SAMPLES) throw new Error("TTS synthesis");
      const pcm = new Float32Array(waveform.data);
      this.samples += pcm.length;
      this.chunks[index] = [];
      if (++this.next === this.chunks.length) this.chunks = [];
      return pcm;
    } finally {
      for (const tensor of Object.values(inputs)) tensor.dispose();
      waveform?.dispose();
    }
  }
}
