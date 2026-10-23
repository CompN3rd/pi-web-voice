import type { SpeechPreparation } from "./speech-assets.js";

export const TTS_PROTOCOL = 1;
export const TTS_SAMPLE_RATE = 24_000;
export const TTS_MAX_TEXT = 1_000;
export const TTS_MAX_CHUNKS = 32;
export const TTS_MAX_CHUNK_SAMPLES = TTS_SAMPLE_RATE * 30;
export const TTS_MAX_TOTAL_SAMPLES = TTS_SAMPLE_RATE * 120;
export const TTS_PREPARE_MS = 300_000;
export const TTS_INITIALIZE_MS = 60_000;
export const TTS_INACTIVITY_MS = 120_000;
export const TTS_JOB_MS = 300_000;
export const TTS_TEARDOWN_MS = 5_000;

export interface TtsProgress {
  phase: "checking" | "initializing";
  checkedBytes?: number;
  totalBytes?: number;
}

/** Controller/runtime seam: preflight every text chunk before emitting any audio.
 * chunk() is pull-based: only one bounded request can be pending; no audio queue.
 * Construction/termination must not load assets or retain text for replay.
 */
export interface TtsRuntime {
  prepare(status: (progress: TtsProgress) => void, options?: SpeechPreparation): Promise<void>;
  plan(text: string): Promise<number>;
  chunk(index: number): Promise<Float32Array>;
  terminate(): void;
}

export function ttsPrefix(text: string): string {
  return text.slice(0, TTS_MAX_TEXT).replace(/[\uD800-\uDBFF]$/, "");
}

export function validTtsPcm(value: unknown): value is Float32Array {
  return value instanceof Float32Array && value.length > 0 && value.length <= TTS_MAX_CHUNK_SAMPLES
    && value.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1);
}
