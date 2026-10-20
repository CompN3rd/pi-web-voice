import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { externalOutput, speechManifest, validAsset } from "../scripts/speech-assets.mjs";

// Optional actual-model smoke, not microphone/accuracy/Pixel/live-host acceptance.
const { values } = parseArgs({ options: { output: { type: "string" } } });
const output = await externalOutput(values.output);
const assets = await speechManifest();
const files = new Map();
for (const asset of assets) {
  const bytes = await readFile(join(output, asset.path));
  assert.ok(validAsset(bytes, asset), `External speech pack mismatch: ${asset.path}`);
  files.set(`/pi-voice-speech/${asset.path}`, bytes);
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
    response.end('<!doctype html><link rel="icon" href="data:,"><title>Local model smoke</title>');
  } else if (files.has(path)) {
    response.setHeader("Content-Type", /\.(?:js|mjs)$/.test(path) ? "text/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    response.end(files.get(path));
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
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
    return await window.call({ id: 1, type: "prepare" });
  });
  assert.equal(ready.type, "ready");
  for (const asset of assets) assert.equal(requests.filter(path => path === `/pi-voice-speech/${asset.path}`).length, 1);
  const count = requests.length;
  inference = true;
  const result = await page.evaluate(async () => {
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin(i * 2 * Math.PI * 220 / 16000);
    const start = performance.now();
    const result = await window.call({ id: 2, type: "transcribe", pcm });
    worker.terminate();
    return { ...result, elapsedMs: Math.round(performance.now() - start) };
  });
  assert.equal(result.type, "transcript");
  assert.equal(typeof result.text, "string");
  assert.deepEqual(unexpected, []);
  assert.deepEqual(inferenceAttempts, [], "inference must not even attempt HTTP");
  assert.equal(requests.length, count, "inference must not reach HTTP server");
  console.log(`PASS real q8 model: prepared ${assets.length} verified external assets; synthetic PCM inference ${result.elapsedMs}ms; zero further HTTP attempts/requests. Not an accuracy claim.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
