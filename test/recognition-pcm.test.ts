import assert from "node:assert/strict";
import test from "node:test";
import { hasSpeechEnergy, MAX_PCM_SAMPLES, PcmResampler } from "../src/browser/recognition-pcm.ts";

for (const rate of [8000, 16000, 44100, 48000, 96000]) {
  test(`PcmResampler uses actual ${rate} Hz rate across arbitrary capture chunks`, () => {
    const input = new Float32Array(rate).fill(0.25);
    const output: number[] = [];
    const resampler = new PcmResampler(rate);
    for (let start = 0; start < input.length; start += 128) resampler.push(input.subarray(start, start + 128), value => output.push(value));
    assert.equal(output.length, 16000);
    assert.ok(output.every(value => Math.abs(value - 0.25) < 1e-6));
  });
}

test("PcmResampler averages downsampled samples instead of trusting 16 kHz constraints", () => {
  const output: number[] = [];
  new PcmResampler(48000).push(new Float32Array([0, 0.3, 0.6, -0.3, 0, 0.3]), value => output.push(value));
  assert.ok(Math.abs(output[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(output[1]) < 1e-6);
  assert.throws(() => new PcmResampler(NaN));
  assert.throws(() => new PcmResampler(0));
});

test("hasSpeechEnergy rejects silence, short sounds, quiet noise, invalid and oversized PCM", () => {
  assert.equal(hasSpeechEnergy(new Float32Array(16000)), false);
  assert.equal(hasSpeechEnergy(new Float32Array(16000).fill(0.001)), false);
  assert.equal(hasSpeechEnergy(new Float32Array(1000).fill(0.5)), false);
  assert.equal(hasSpeechEnergy(new Float32Array(16000).fill(NaN)), false);
  assert.equal(hasSpeechEnergy(new Float32Array(MAX_PCM_SAMPLES + 1).fill(0.1)), false);
  assert.equal(hasSpeechEnergy(new Float32Array(8000).fill(0.1)), true);
});

test("hasSpeechEnergy validates the trailing partial frame without counting it as a full active frame", () => {
  for (const tail of [1, 160, 319]) {
    const pcm = new Float32Array(8000 + tail).fill(0.1);
    assert.equal(hasSpeechEnergy(pcm), true);
    for (const invalid of [NaN, Infinity, -Infinity]) {
      pcm[pcm.length - 1] = invalid;
      assert.equal(hasSpeechEnergy(pcm), false);
    }
  }
  const shortBurst = new Float32Array(4001);
  shortBurst.fill(0.1, 0, 4 * 320);
  shortBurst.fill(0.5, 3840);
  assert.equal(hasSpeechEnergy(shortBurst), false);
});
