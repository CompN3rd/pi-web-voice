import assert from "node:assert/strict";
import test from "node:test";
import { encodeTtsText, normalizeTtsText, planTtsText, type FidelityTokenizer } from "../src/browser/tts-text.js";
import { ttsPrefix } from "../src/browser/tts-contract.js";
const charEncoder = async (value: string) => [0, ...Array.from(value, c => c.codePointAt(0)!), 0];
const tokenizer: FidelityTokenizer = {
  encode(value, { add_special_tokens }) { const ids = Array.from(value, c => c.codePointAt(0)!); return add_special_tokens ? [0, ...ids, 0] : ids; },
  decode(ids) { return String.fromCodePoint(...ids); },
};

test("tts-text: budget includes two special tokens and every selected character survives splits", async () => {
  for (const text of ["word ".repeat(102).trim(), "word ".repeat(103).trim(), "word ".repeat(200).trim(), "Dr. Smith read 123.45 at 10:30! ".repeat(30), "A sentence. Another sentence? ".repeat(30)]) {
    const result = await planTtsText(text, charEncoder);
    assert.equal(result.map(chunk => chunk.text).join(""), normalizeTtsText(text));
    assert.ok(result.every(chunk => chunk.ids.length <= 512));
    assert.equal(result.length, text.length <= 510 ? 1 : 2);
  }
});

test("tts-text: deterministic punctuation normalization and safe prefix; reject unsupported Unicode", async () => {
  assert.equal(normalizeTtsText("“Hello”—it’s 3…\nYes."), '"Hello"—it\'s 3... Yes.');
  assert.equal(ttsPrefix("x".repeat(999) + "😀"), "x".repeat(999));
  for (const text of ["", "  ", "😀", "Hello 😀", "中文", "Mixed русский", "café", "e\u0301", "a\u0000b", "a\ud800b", "x".repeat(1001), "...", "https://example.com", "const x = 1;", "user_name", "$3.50"]) {
    await assert.rejects(planTtsText(text, charEncoder), /TTS text/);
  }
});

test("tts-text: bounded no-progress, malformed tokens and chunk overflow reject", async () => {
  await assert.rejects(planTtsText("x", async () => Array(513).fill(1)), /TTS text/);
  await assert.rejects(planTtsText("word ".repeat(200).trim(), async text => Array(text.length * 100 + 2).fill(1)), /TTS text/);
  for (const ids of [[], [0, 0], [0, NaN, 0], [0, -1, 0], [0, 1.2, 0]]) await assert.rejects(planTtsText("x", async () => ids), /TTS text/);
});

test("tts-text: phonemizer English pin, punctuation preserved and tokenizer round-trip prevents loss", async () => {
  const calls: string[] = [];
  const ids = await encodeTtsText("Hello, world!", async (span, language) => { assert.equal(language, "en-us"); calls.push(span); return [span]; }, tokenizer);
  assert.deepEqual(calls, ["Hello", "world"]);
  assert.equal(tokenizer.decode(ids.slice(1, -1), { skip_special_tokens: false, clean_up_tokenization_spaces: false }), "Hello, woɹld!");
  await assert.rejects(encodeTtsText("x", async () => ["unsupported"], { ...tokenizer, decode: () => "discarded" }), /TTS text/);
  await assert.rejects(encodeTtsText("x", async () => [], tokenizer), /TTS text/);
  await assert.rejects(encodeTtsText("x", async () => [" "], tokenizer), /TTS text/);
  await assert.rejects(encodeTtsText("x", async () => ["x"], { ...tokenizer, encode: () => [1, 2, 3] }), /TTS text/);
});

test("tts-text: decimals, grouping, times and dotted abbreviations reach the phonemizer intact", async () => {
  const calls: string[] = [];
  const text = 'Read 3.14, 1,234.50 at 10:30:05. Ask Dr. Smith in the U.S.; e.g., 3rd.';
  const ids = await encodeTtsText(text, async span => { calls.push(span); return [span]; }, tokenizer);
  assert.deepEqual(calls, ["Read", "3.14", "1,234.50", "at", "10:30:05", "Ask", "Dr", "Smith", "in", "the", "U.S.", "e.g.", "3rd"]);
  assert.equal(tokenizer.decode(ids.slice(1, -1), { skip_special_tokens: false, clean_up_tokenization_spaces: false }), text.replace(/r/g, "ɹ"));
});

test("tts-text: unqualified numeric forms reject before any prefix is encoded", async () => {
  for (const text of ["-3", "- 3", "—3", "+3", "−3", "3-5", "3 – 5", "3 — 5", "1,23", "1.2.3", "3..14", "25:99", ".5", "3.14kg"]) {
    let calls = 0;
    await assert.rejects(planTtsText(`Read this first. ${text}`, async value => { calls++; return charEncoder(value); }), /TTS text/, text);
    assert.equal(calls, 0, text);
  }
  assert.equal(normalizeTtsText("needs-input – next—step"), "needs—input — next—step");
});

test("tts-text: budget splitting cannot bisect numeric expressions or dotted abbreviations", async () => {
  for (const atom of ["3.14", "1,234", "10:30", "U.S.", "1234567890", "3rd"]) {
    const calls: string[] = [];
    await assert.rejects(planTtsText(atom, async value => { calls.push(value); return Array(513).fill(1); }), /TTS text/);
    assert.deepEqual(calls, [atom], atom);
  }
  const text = `${"word ".repeat(98)}123.45 ${"word ".repeat(98).trim()}`;
  const chunks = await planTtsText(text, charEncoder);
  assert.equal(chunks.map(chunk => chunk.text).join(""), text);
  assert.equal(chunks.filter(chunk => chunk.text.includes("123.45")).length, 1);
  assert.ok(chunks.every(chunk => chunk.ids.length <= 512));
  await assert.rejects(planTtsText("1".repeat(511), charEncoder), /TTS text/);
});

test("tts-text: numeric and phonemizer span ceilings reject before eSpeak can truncate", async () => {
  for (const text of ["1".repeat(15), "123,456,789,012,345", "1234567890.12345", "x".repeat(32)]) {
    const chunks = await planTtsText(text, charEncoder);
    assert.equal(chunks[0].text, text);
  }
  for (const text of ["1".repeat(16), "1,234,567,890,123,456", "1234567890.123456", "x".repeat(33), "x".repeat(511)]) {
    let calls = 0;
    await assert.rejects(planTtsText(text, async value => { calls++; return charEncoder(value); }), /TTS text/);
    await assert.rejects(encodeTtsText(text, async () => { calls++; return ["x"]; }, tokenizer), /TTS text/);
    assert.equal(calls, 0, text);
  }
});

test("tts-text: later unrepresentable spans reject all-prefix preflight", async () => {
  let attempts = 0;
  await assert.rejects(planTtsText("word ".repeat(200).trim(), async text => {
    if (++attempts === 3) throw Error("TTS text");
    return charEncoder(text);
  }), /TTS text/);
  assert.equal(attempts, 3);
});
