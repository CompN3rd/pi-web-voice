import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { externalOutput, externalPath, sha256, speechManifest, validAsset } from "../scripts/speech-assets.mjs";
import { MAX_PCM_SAMPLES, PcmResampler } from "../src/browser/recognition-pcm.ts";
import { normalizeTranscript } from "./transcript-comparison.ts";

// Optional actual-model smoke, not microphone/accuracy/Pixel/live-host acceptance.
const { values } = parseArgs({ options: { output: { type: "string" }, "synthetic-speech": { type: "string" } } });
const output = await externalOutput(values.output);
let syntheticSpeech;
if (values["synthetic-speech"]) {
  const path = await externalPath(values["synthetic-speech"]);
  assert.ok((await stat(path)).size < 8_000_000, "bounded explicit synthetic fixture");
  const bytes = await readFile(path);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.kind, "synthetic-kokoro-test-v1");
  assert.equal(fixture.text, "Hello world. This is local English speech.");
  assert.equal(fixture.sampleRate, 24000);
  assert.match(fixture.packSha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(fixture.pcm) && fixture.pcm.length > 0 && fixture.pcm.length <= 480000);
  assert.ok(fixture.pcm.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
  const pcm = [];
  new PcmResampler(fixture.sampleRate).push(Float32Array.from(fixture.pcm), sample => pcm.push(sample));
  assert.equal(pcm.length, Math.floor(fixture.pcm.length * 16000 / fixture.sampleRate));
  assert.ok(pcm.length <= MAX_PCM_SAMPLES);
  syntheticSpeech = { pcm, text: fixture.text, sha256: sha256(bytes) };
}
const assets = await speechManifest();
const files = new Map();
const packParts = [Buffer.from("PIVOICE1")];
for (const asset of assets) {
  const bytes = await readFile(join(output, asset.path));
  assert.ok(validAsset(bytes, asset), `External speech pack mismatch: ${asset.path}`);
  packParts.push(bytes);
}
files.set("/nested/voice/recognition-worker.js", await readFile("dist/browser/recognition-worker.js"));
const executablePath = process.env.VOICE_BROWSER_EXECUTABLE ?? (process.platform === "win32"
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
if (!executablePath || !existsSync(executablePath)) throw new Error("Set VOICE_BROWSER_EXECUTABLE to installed Chromium/Edge; this command downloads none.");
const requests = [];
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  requests.push(path);
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:");
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><link rel="icon" href="data:,"><title>Local model smoke</title><input type=file>');
  } else if (files.has(path)) {
    response.setHeader("Content-Type", /\.(?:js|mjs)$/.test(path) ? "text/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    response.end(files.get(path));
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const temporary = await mkdtemp(join(tmpdir(), "pi-voice-model-import-"));
try {
  const importPath = join(temporary, "speech.pivoice");
  await writeFile(importPath, Buffer.concat(packParts));
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", permissions: [] });
  let inference = false;
  const unexpected = [];
  const inferenceAttempts = [];
  await context.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (inference) { inferenceAttempts.push(url.href); return route.abort(); }
    if (url.origin === origin && (url.pathname === "/" || files.has(url.pathname)) && !url.search && request.method() === "GET") return route.continue();
    unexpected.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator("input").setInputFiles(importPath);
  const ready = await page.evaluate(async () => {
    window.worker = new Worker("/nested/voice/recognition-worker.js", { type: "module" });
    window.call = message => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Model smoke timed out")), 180_000);
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (data.type === "status" || data.id !== message.id) return;
        clearTimeout(timer);
        data.type === "error" ? reject(new Error(data.message)) : resolve(data);
      };
      worker.postMessage(message);
    });
    return await window.call({ id: 1, type: "prepare", options: { source: "import", file: document.querySelector("input").files[0] } });
  });
  assert.equal(ready.type, "ready");
  assert.deepEqual(requests.filter(path => path.includes("speech-cache") || path.includes("pi-voice-speech")), [], "no model server route or internal cache URL fetch");
  const count = requests.length;
  inference = true;
  const result = await page.evaluate(async synthetic => {
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin(i * 2 * Math.PI * 220 / 16000);
    const start = performance.now();
    const result = await window.call({ id: 2, type: "transcribe", pcm });
    const elapsedMs = Math.round(performance.now() - start);
    let speech;
    if (synthetic) {
      const started = performance.now();
      speech = await window.call({ id: 3, type: "transcribe", pcm: Float32Array.from(synthetic.pcm) });
      speech.elapsedMs = Math.round(performance.now() - started);
    }
    worker.terminate();
    return { ...result, elapsedMs, speech };
  }, syntheticSpeech);
  assert.equal(result.type, "transcript");
  assert.equal(typeof result.text, "string");
  assert.deepEqual(unexpected, []);
  assert.deepEqual(inferenceAttempts, [], "inference must not even attempt HTTP");
  assert.equal(requests.length, count, "inference must not reach HTTP server");
  console.log(`PASS real q8 model: prepared ${assets.length} verified external assets; synthetic PCM inference ${result.elapsedMs}ms; zero further HTTP attempts/requests. Not an accuracy claim.`);
  if (syntheticSpeech) {
    assert.equal(result.speech.type, "transcript");
    assert.equal(normalizeTranscript(result.speech.text), normalizeTranscript(syntheticSpeech.text), "known synthetic Kokoro sentence round-trip, ignoring punctuation/case and normalizing whitespace");
    console.log(`PASS synthetic Kokoro to real Whisper round-trip: ${JSON.stringify({ text: result.speech.text, elapsedMs: result.speech.elapsedMs, fixtureSha256: syntheticSpeech.sha256 })}; not microphone/general accuracy acceptance.`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
