import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { ttsPhonemizerInput } from "./tts-phonemizer-input.mjs";

const { bytes: phonemizer, candidate } = await ttsPhonemizerInput();
const inventory = JSON.parse(await readFile(new URL("../scripts/tts-pack.json", import.meta.url), "utf8"));
const parts = [];
for (const name of ["tokenizer.json", "tokenizer_config.json"]) {
  const bytes = await readFile(new URL(`./fixtures/tts/${name}`, import.meta.url));
  const expected = inventory.files.find(asset => asset.path === name);
  assert.equal(bytes.length, expected.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
  parts.push(JSON.parse(bytes.toString("utf8")));
}
const bundle = await build({
  stdin: { contents: `
    export { PreTrainedTokenizer } from "@huggingface/transformers";
    export { encodeTtsText, normalizeTtsText, planTtsText } from "./src/browser/tts-text.ts";
  `, resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
});
const executablePath = process.env.VOICE_BROWSER_EXECUTABLE ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
assert.ok(executablePath && existsSync(executablePath), "Set VOICE_BROWSER_EXECUTABLE to installed Chromium/Edge; no downloads.");
const browser = await chromium.launch({ executablePath, headless: true });
const unexpected = [];
const requests = [];
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const origin = "http://127.0.0.1:19283";
  const routes = new Map([
    [`${origin}/`, { contentType: "text/html", body: "<!doctype html><title>Phonemizer fidelity</title>" }],
    [`${origin}/fidelity.js`, { contentType: "text/javascript", body: bundle.outputFiles[0].text }],
    [`${origin}/phonemizer.js`, { contentType: "text/javascript", body: phonemizer }],
  ]);
  await context.route("**/*", route => {
    const url = route.request().url(); requests.push(url);
    const response = routes.get(url);
    if (response && route.request().method() === "GET") return route.fulfill(response);
    unexpected.push(url); return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async ({ parts, candidate }) => {
    const { PreTrainedTokenizer, encodeTtsText, normalizeTtsText, planTtsText } = await import("/fidelity.js");
    let deniedTransports = 0;
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker", "EventSource", "WebTransport"])
      globalThis[name] = function() { deniedTransports++; throw Error("phonemizer transport forbidden"); };
    const { phonemize } = await import("/phonemizer.js");
    if (candidate) {
      const expected = ["həlˈoʊ wˈɜːld", "θɹˈiː pɔɪnt wˈʌn fˈɔːɹ", "jˌuːˈɛs"];
      // Independent source-built CLI reference, also repeated concurrently to
      // exercise initialization and ownership of the native input cursor.
      const inputs = ["Hello world.", "3.14", "U.S."];
      const results = await Promise.all([...inputs, ...inputs].map(text => phonemize(text, "en-us")));
      if (JSON.stringify(results.map(parts => parts.join(" "))) !== JSON.stringify([...expected, ...expected])) throw Error("candidate CLI reference mismatch");
      const clauses = await phonemize("Good morning! Ready?", "en-us");
      if (JSON.stringify(clauses) !== JSON.stringify(["ɡˈʊd mˈɔːɹnɪŋ", "ɹˈɛdi"])) throw Error("candidate clause loss");
      if ((await phonemize(" ", "en-us")).length !== 0) throw Error("empty input");
      for (const [text, language] of [["hello", "fr"], ["a\u0000b", "en-us"], ["x".repeat(1001), "en-us"]]) {
        let rejected = false;
        try { await phonemize(text, language); } catch { rejected = true; }
        if (!rejected) throw Error("candidate boundary accepted invalid input");
      }
    }
    const tokenizer = new PreTrainedTokenizer(...parts);
    const ipa = text => text.replace(/r/g, "ɹ").replace(/ʲ/g, "j").replace(/x/g, "k").replace(/ɬ/g, "l");
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const decode = ids => ids.slice(1, -1).map(id => tokenizer.decode([id], { skip_special_tokens: false, clean_up_tokenization_spaces: false })).join("");
    const evidence = [];
    for (const text of ["3.14", "1,234", "1,234.50", "10:30", "12:34:56", "U.S.", "e.g.", "i.e.", "Dr.", "Mr.", "3rd", "1".repeat(15), "123,456,789,012,345", "1234567890.12345", "x".repeat(32)]) {
      const calls = [];
      const ids = await encodeTtsText(text, async (span, language) => { calls.push(span); return phonemize(span, language); }, tokenizer);
      const direct = ipa((await phonemize(text, "en-us")).join(" ").trim());
      // Titles retain the sentence punctuation policy, but their phonemes must
      // equal the unsplit title. Dotted initialisms are delivered intact.
      const expected = direct + (["Dr.", "Mr."].includes(text) ? "." : "");
      check(decode(ids) === expected, `direct phonemizer mismatch: ${text}`);
      check(calls.length === 1 && calls[0] === (["Dr.", "Mr."].includes(text) ? text.slice(0, -1) : text), `split expression: ${text}`);
      evidence.push({ text, calls, phonemes: decode(ids) });
    }
    const calls = [];
    const prose = "Read 3.14, then 1,234 at 10:30. Ask Dr. Smith in the U.S.!";
    const chunks = await planTtsText(prose, text => encodeTtsText(text, async (span, language) => { calls.push(span); return phonemize(span, language); }, tokenizer));
    check(chunks.length === 1 && chunks[0].text === prose, "prose preflight");
    for (const expression of ["3.14", "1,234", "10:30", "U.S."]) check(calls.includes(expression), `missing atomic expression: ${expression}`);
    const rejects = ["-3", "—3", "+3", "−3", "3-5", "3 – 5", "1,23", "1.2.3", "25:99", ".5", "3.14kg", "1".repeat(16), "1,234,567,890,123,456", "1234567890.123456", "x".repeat(33)];
    for (const text of rejects) {
      let rejected = false;
      try { await planTtsText(text, value => encodeTtsText(value, phonemize, tokenizer)); } catch { rejected = true; }
      check(rejected, `unqualified expression accepted: ${text}`);
    }
    const longText = "Read 3.14 at 10:30. ".repeat(45).trim();
    const longCalls = [];
    const longChunks = await planTtsText(longText, text => encodeTtsText(text, async (span, language) => { longCalls.push(span); return phonemize(span, language); }, tokenizer));
    check(longChunks.length > 1 && longChunks.every(chunk => chunk.ids.length <= 512), "real token-budget splitting");
    check(longChunks.map(chunk => chunk.text).join("") === longText, "long prefix changed");
    check(longCalls.every(span => ["Read", "3.14", "at", "10:30"].includes(span)), "numeric span split during real preflight");
    let oversizedRejected = false;
    const oversizedCalls = [];
    try {
      await planTtsText("1".repeat(511), text => encodeTtsText(text, async (span, language) => { oversizedCalls.push(span); return phonemize(span, language); }, tokenizer));
    } catch { oversizedRejected = true; }
    check(oversizedRejected && oversizedCalls.length === 0, "long numeric expression reached eSpeak");
    // Concrete reason for pre-phonemizer input ceilings: the real module maps
    // different long inputs to identical incomplete output, below 512 tokens.
    const truncation = [];
    for (const char of ["1", "x"]) {
      const short = (await phonemize(char.repeat(100), "en-us")).join(" ");
      const long = (await phonemize(char.repeat(511), "en-us")).join(" ");
      check(short === long, "pinned native truncation premise changed");
      truncation.push({ char, inputLengths: [100, 511], identical: short === long, outputLengths: [short.length, long.length] });
    }
    // Actual pinned eSpeak proves why normalizing signed/range input is unsafe.
    check((await phonemize("-3", "en-us")).join("") !== (await phonemize("—3", "en-us")).join(""), "signed-number qualification premise");
    check((await phonemize("3-5", "en-us")).join("") !== (await phonemize("3—5", "en-us")).join(""), "range qualification premise");
    const dashed = await encodeTtsText(normalizeTtsText("needs-input"), phonemize, tokenizer);
    check(decode(dashed).includes("—"), "supported dash lost");
    let rejected = false;
    try { await encodeTtsText("Hello", async () => ["həlˈoʊ☃"], tokenizer); } catch { rejected = true; }
    check(rejected, "unsupported phoneme discarded");
    check(deniedTransports === 0, "phonemizer attempted transport");
    return { evidence, rejects, proseChunks: chunks.length, longChunks: longChunks.length, oversizedRejected, truncation, deniedTransports };
  }, { parts, candidate });
  assert.deepEqual(unexpected, []);
  assert.equal(requests.length, 3, "only the in-memory document and two verified/local modules were requested");
  console.log(`PASS actual pinned ${candidate ? "source-built candidate" : "published phonemizer"} + tokenizer fidelity (${browser.version()}): ${JSON.stringify(result)}`);
  console.log("No weights, audio, downloads, external requests or pronunciation acceptance.");
} finally { await browser.close(); }
