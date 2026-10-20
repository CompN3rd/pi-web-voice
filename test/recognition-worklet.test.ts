import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PCM_SAMPLES } from "../src/browser/recognition-pcm.ts";

test("RecognitionCaptureProcessor mixes channels, resamples actual rate and stops at 20 seconds", async () => {
  const output: Float32Array[] = [];
  let Processor!: new () => { process(input: Float32Array[][]): boolean };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(["sampleRate", "AudioWorkletProcessor", "registerProcessor"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globals.sampleRate = 48000;
  globals.AudioWorkletProcessor = class { port = { postMessage: (pcm: Float32Array) => output.push(pcm) }; };
  globals.registerProcessor = (name: string, constructor: typeof Processor) => { assert.equal(name, "local-recognition-capture"); Processor = constructor; };
  try {
    await import("../src/browser/recognition-worklet.ts");
    const processor = new Processor();
    const channels = [new Float32Array(128).fill(0.4), new Float32Array(128).fill(0.2)];
    let alive = true;
    for (let i = 0; i < 20 * 48000 / 128; i++) alive = processor.process([channels]);
    assert.equal(alive, false);
    assert.equal(output.reduce((sum, chunk) => sum + chunk.length, 0), MAX_PCM_SAMPLES);
    assert.ok(output.every(chunk => chunk.every(value => Math.abs(value - 0.3) < 1e-6)));
    assert.equal(processor.process([channels]), false);
    assert.equal(output.reduce((sum, chunk) => sum + chunk.length, 0), MAX_PCM_SAMPLES);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
