export const SPEECH_SAMPLE_RATE = 16_000;
export const MAX_UTTERANCE_SECONDS = 20;
export const MAX_PCM_SAMPLES = SPEECH_SAMPLE_RATE * MAX_UTTERANCE_SECONDS;
export const MAX_TRANSCRIPT_CHARACTERS = 4_000;

/** Streaming area-average resampling at the actual AudioContext rate, including fractional boundaries. */
export class PcmResampler {
  private remaining: number;
  private sum = 0;
  private readonly ratio: number;
  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new Error("Unsupported microphone sample rate");
    this.remaining = this.ratio = sampleRate / SPEECH_SAMPLE_RATE;
  }
  push(input: Float32Array, output: (sample: number) => void): void {
    for (const raw of input) {
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let left = 1;
      while (left > 1e-9) {
        const weight = Math.min(left, this.remaining);
        this.sum += sample * weight;
        left -= weight;
        this.remaining -= weight;
        if (this.remaining < 1e-9) {
          output(this.sum / this.ratio);
          this.sum = 0;
          this.remaining = this.ratio;
        }
      }
    }
  }
}

/** Energy gate, not a speech classifier: noise/music can still pass and must never grant authority. */
export function hasSpeechEnergy(pcm: Float32Array): boolean {
  if (pcm.length < SPEECH_SAMPLE_RATE / 4 || pcm.length > MAX_PCM_SAMPLES) return false;
  let activeFrames = 0;
  const frame = 320; // At least 100 ms above -40 dBFS in 20 ms frames.
  for (let i = 0; i < pcm.length; i += frame) {
    const end = Math.min(i + frame, pcm.length);
    let power = 0;
    for (let j = i; j < end; j++) {
      if (!Number.isFinite(pcm[j])) return false;
      power += pcm[j] ** 2;
    }
    if (end - i === frame && power / frame >= 0.0001) activeFrames++;
  }
  return activeFrames >= 5;
}
