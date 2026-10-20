import { MAX_PCM_SAMPLES, PcmResampler } from "./recognition-pcm.js";

// AudioWorklet globals are absent from the project's window DOM declarations.
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class RecognitionCaptureProcessor extends AudioWorkletProcessor {
  private resampler = new PcmResampler(sampleRate);
  private batch = new Float32Array(160);
  private used = 0;
  private total = 0;
  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels?.length || this.total >= MAX_PCM_SAMPLES) return this.total < MAX_PCM_SAMPLES;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    this.resampler.push(mono, sample => {
      if (this.total >= MAX_PCM_SAMPLES) return;
      this.batch[this.used++] = sample;
      this.total++;
      if (this.used === this.batch.length) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(160);
        this.used = 0;
      }
    });
    return this.total < MAX_PCM_SAMPLES;
  }
}
registerProcessor("local-recognition-capture", RecognitionCaptureProcessor);
