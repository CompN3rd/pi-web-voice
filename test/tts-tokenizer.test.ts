import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PreTrainedTokenizer } from "@huggingface/transformers";
import { encodeTtsText } from "../src/browser/tts-text.ts";

async function pinnedTokenizer() {
  const inventory = JSON.parse(await readFile(new URL("../scripts/tts-pack.json", import.meta.url), "utf8"));
  const parts = [];
  for (const name of ["tokenizer.json", "tokenizer_config.json"]) {
    const bytes = await readFile(new URL(`./fixtures/tts/${name}`, import.meta.url));
    const expected = inventory.files.find((asset: { path: string }) => asset.path === name);
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    parts.push(JSON.parse(bytes.toString("utf8")));
  }
  // Public constructor, exact pinned JSON; no model, phonemizer or network request.
  return new PreTrainedTokenizer(parts[0], parts[1]);
}

test("actual pinned Kokoro tokenizer preserves phonemes despite its space-joining sequence decoder", async () => {
  const tokenizer = await pinnedTokenizer();
  const phonemes = "həlˈoʊ";
  const body = tokenizer.encode(phonemes, { add_special_tokens: false });
  assert.notEqual(tokenizer.decode(body, { clean_up_tokenization_spaces: false }), phonemes);
  const ids = await encodeTtsText("Hello", async () => [phonemes], tokenizer);
  assert.deepEqual(ids, [0, ...body, 0]);
});

test("actual pinned tokenizer retains complete numeric and dotted-abbreviation phonemes", async () => {
  const tokenizer = await pinnedTokenizer();
  // Observed from the hash-verified phonemizer@1.2.1 browser module; the optional
  // tts-phonemizer-browser.mjs check exercises that real module as well.
  const cases = new Map([
    ["3.14", "θɹˈiː pɔɪnt wˈʌn fˈoːɹ"],
    ["1,234", "wˈʌn θˈaʊzənd tˈuːhˈʌndɹɪd θˈɜːɾi fˈoːɹ"],
    ["10:30", "tˈɛn θˈɜːɾi"],
    ["U.S.", "jˌuːˈɛs"],
  ]);
  for (const [text, phonemes] of cases) {
    const calls: string[] = [];
    const ids = await encodeTtsText(text, async span => { calls.push(span); assert.equal(span, text); return [phonemes]; }, tokenizer);
    assert.deepEqual(calls, [text]);
    assert.deepEqual(ids, tokenizer.encode(phonemes, { add_special_tokens: true }));
    assert.equal(ids.slice(1, -1).map(id => tokenizer.decode([id], { clean_up_tokenization_spaces: false })).join(""), phonemes);
  }
});

test("actual pinned vocabulary retains normalized dashes and still rejects discarded phonemes", async () => {
  const tokenizer = await pinnedTokenizer();
  const { normalizeTtsText } = await import("../src/browser/tts-text.ts");
  const phonemes = new Map([["needs", "nˈiːdz"], ["input", "ˈɪnpʊt"]]);
  const ids = await encodeTtsText(normalizeTtsText("needs-input"), async text => [phonemes.get(text)!], tokenizer);
  const decoded = ids.slice(1, -1).map(id => tokenizer.decode([id], { clean_up_tokenization_spaces: false })).join("");
  assert.equal(decoded, "nˈiːdz—ˈɪnpʊt");
  await assert.rejects(encodeTtsText("Hello", async () => ["həlˈoʊ☃"], tokenizer), /TTS text/);
});
