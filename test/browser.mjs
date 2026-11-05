import { chromium } from "playwright-core";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { speechManifest, speechCacheName } from "../scripts/speech-assets.mjs";
const packInfo = {};
for (const kind of ["recognition", "tts"]) {
  const assets = await speechManifest(kind);
  packInfo[kind] = { kind, cacheName: speechCacheName(kind, assets), assets };
}
const output = await build({
  entryPoints: ["test/browser-fixture.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  define: { __VOICE_PACKS__: JSON.stringify(packInfo), __TTS_BUILD__: JSON.stringify("fixture-build"), __TTS_CACHE__: JSON.stringify(packInfo.tts.cacheName) },
  plugins: [{ name: "fixture-local-recognizer", setup(build) {
    build.onResolve({ filter: /^\.\/audio\.ts$/ }, args => args.importer.replaceAll("\\", "/").endsWith("/src/browser/index.ts")
      ? { path: resolve("test/browser-fixture.ts") } : undefined);
    build.onResolve({ filter: /^\.\/tts-runtime\.js$/ }, args => args.importer.replaceAll("\\", "/").endsWith("/src/browser/index.ts")
      ? { path: resolve("test/browser-fixture.ts") } : undefined);
  } }],
});
const executablePath = process.env.VOICE_BROWSER_EXECUTABLE ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
if (!executablePath || !existsSync(executablePath)) throw new Error("Set VOICE_BROWSER_EXECUTABLE to an installed Chromium/Edge browser; this test downloads none.");
const browser = await chromium.launch({ executablePath, headless: true });
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10000);
  const errors = []; const blockedNetwork = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (url === "http://localhost:43119/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width"><script type="module" src="/fixture.js"></script>' });
    if (url === "http://localhost:43119/fixture.js") return route.fulfill({ contentType: "text/javascript", body: output.outputFiles[0].text });
    blockedNetwork.push(url); return route.abort();
  });
  const button = name => page.getByRole("button", { name, exact: true });
  const prompt = () => page.getByLabel("Editable transcript / task text");
  const reset = async () => { await page.goto("http://localhost:43119/"); await page.getByText("No tracked workers in this workspace.", { exact: true }).waitFor(); await page.getByText("Speech setup & storage", { exact: true }).click(); };
  const prepare = async () => { await button("Prepare local English speech pack").click(); await page.getByText("Local speech ready · audio stays on this device", { exact: true }).waitFor(); };
  const start = async () => { await button("Start recording").click(); await page.getByText("Listening locally · finish within 20 seconds", { exact: true }).waitFor(); };
  const prepareTts = async () => {
    if (!await page.evaluate(() => document.querySelector("compn3rd-voice-panel").speech?.ready)) await button("Prepare cached TTS pack").click();
    await page.waitForFunction(() => document.querySelector("compn3rd-voice-panel").speech?.ready).catch(async error => {
      console.error(await page.evaluate(() => { const p = document.querySelector("compn3rd-voice-panel"); return { status: p.speech?.status, error: p.error, stats: fixture.stats }; }));
      throw error;
    });
  };
  const enableTts = async () => page.getByLabel("Enable English Heart playback", { exact: true }).check();
  const speakStatus = async () => {
    const count = await page.evaluate(() => fixture.stats.spoken.length);
    await button("Speak worker status").click();
    await page.waitForFunction(count => fixture.stats.spoken.length === count + 1, count);
  };
  const speakResult = async () => {
    const count = await page.evaluate(() => fixture.stats.spoken.length);
    await button("Speak result / question prefix").click();
    await page.waitForFunction(count => fixture.stats.spoken.length === count + 1, count);
  };
  const propose = async (title = "Fixture task", instruction = "Inspect tests; do not edit files") => {
    await page.getByLabel("Title", { exact: true }).fill(title);
    await prompt().fill(instruction);
    await button("Propose exact instruction").click();
    await page.getByRole("article", { name: "Exact proposal" }).waitFor();
  };
  const createWorker = async () => {
    await propose(); await button("Approve exact instruction").click();
    await page.waitForFunction(() => fixture.stats.instructions === 1);
    await button("Read text / question").waitFor();
  };
  const settleWorker = async () => {
    await page.evaluate(() => fixture.setWorkerStatus("completed"));
    await button("Refresh status").click();
    await page.getByLabel("Instruction target").locator("option").last().filter({ hasText: "completed" }).waitFor({ state: "attached" });
  };
  const chooseReply = async () => {
    const value = await page.getByLabel("Instruction target").locator("option").last().getAttribute("value");
    await page.getByLabel("Instruction target").selectOption(value);
  };
  const unchangedDraft = async () => { assert.equal(await prompt().inputValue(), ""); assert.equal(await page.getByRole("article", { name: "Exact proposal" }).count(), 0); checks++; };

  // Acquisition authority is explicit; preparation/import/download never capture or dispatch.
  await reset(); await prepare();
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), [{ source: "cache" }]);
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.instructions), 0); checks++;
  await reset();
  await button("Download pinned English speech pack · ~65 MB").click();
  await page.getByText("Local speech ready · audio stays on this device", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), [{ source: "download" }]);
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.instructions), 0); checks++;
  const choosePack = async () => {
    const picking = page.waitForEvent("filechooser");
    await page.getByLabel("Import local speech pack (.pivoice)", { exact: true }).click();
    return picking;
  };
  const fixturePack = { name: "fixture.pivoice", mimeType: "application/octet-stream", buffer: Buffer.from("PIVOICE1") };
  await reset();
  await (await choosePack()).setFiles(fixturePack);
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), []);
  await button("Import selected speech pack").click();
  await page.getByText("Local speech ready · audio stays on this device", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), [{ source: "import", bytes: 8 }]);
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.instructions), 0); checks++;
  await reset();
  const stalePicker = await choosePack();
  await page.evaluate(() => fixture.mount("workspace-b"));
  await page.getByText("Test machine / Test project / workspace-b", { exact: true }).waitFor();
  await stalePicker.setFiles(fixturePack);
  await page.evaluate(() => document.querySelector("compn3rd-voice-panel").updateComplete);
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), []);
  assert.equal(await button("Import selected speech pack").count(), 0); checks++;
  // Android may hide the page while its native file picker is open. Selection is
  // retained for this context, but no import happens until a fresh visible tap.
  await reset();
  const mobilePicker = await choosePack();
  await page.evaluate(() => fixture.setHidden(true));
  await mobilePicker.setFiles(fixturePack);
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), []);
  await page.evaluate(() => fixture.setHidden(false));
  await button("Import selected speech pack").click();
  await page.getByText("Local speech ready · audio stays on this device", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => fixture.stats.acquisitions), [{ source: "import", bytes: 8 }]);
  assert.equal(await page.evaluate(() => fixture.stats.captures), 0); checks++;
  for (const source of ["download", "import"]) {
    await reset(); await page.evaluate(() => { fixture.stats.pendingPrepare = true; });
    if (source === "download") await button("Download pinned English speech pack · ~65 MB").click();
    else { await (await choosePack()).setFiles(fixturePack); await button("Import selected speech pack").click(); }
    await page.waitForFunction(() => fixture.stats.preparations === 1);
    await button("Cancel / voice off").click();
    await page.evaluate(() => fixture.resolvePrepare());
    await page.evaluate(() => document.querySelector("compn3rd-voice-panel").updateComplete);
    assert.equal(await button("Start recording").isEnabled(), false);
    assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.instructions), 0); checks++;
  }

  const chooseTtsPack = async () => {
    const picking = page.waitForEvent("filechooser");
    await page.getByLabel("Import TTS pack (.pivoice)", { exact: true }).click();
    return picking;
  };
  const ttsFixturePack = { ...fixturePack, buffer: Buffer.from("PIVOTTS1") };
  await reset();
  assert.equal(await button("Download pinned TTS pack").isDisabled(), true);
  assert.equal(await page.getByText(/TTS download unavailable: the source-built/).isVisible(), true);
  assert.deepEqual(await page.evaluate(() => fixture.stats.ttsAcquisitions), []);
  assert.match(await page.evaluate(async () => { try { await document.querySelector("compn3rd-voice-panel").prepareTts({ source: "download" }); } catch (error) { return error.message; } }), /TTS download unavailable/);
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.audioContexts + fixture.stats.instructions), 0); checks++;
  await reset();
  const hiddenTtsPicker = await chooseTtsPack();
  await page.evaluate(() => fixture.setHidden(true));
  await hiddenTtsPicker.setFiles(ttsFixturePack);
  assert.deepEqual(await page.evaluate(() => fixture.stats.ttsAcquisitions), []);
  await page.evaluate(() => fixture.setHidden(false));
  await button("Import selected TTS pack").click();
  await page.waitForFunction(() => document.querySelector("compn3rd-voice-panel").speech?.ready);
  assert.deepEqual(await page.evaluate(() => fixture.stats.ttsAcquisitions), [{ source: "import", bytes: 8 }]);
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.audioContexts), 0); checks++;
  // Same-scope ABA and a replacement of either pack kind cannot revive an old input.
  for (const replacement of ["aba", "tts", "recognition"]) {
    await reset(); const oldPicker = await chooseTtsPack();
    if (replacement === "aba") {
      await page.evaluate(() => fixture.mount("workspace-b"));
      await page.getByText("Test machine / Test project / workspace-b", { exact: true }).waitFor();
      await page.evaluate(() => fixture.mount("workspace-a"));
      await page.getByText("Test machine / Test project / workspace-a", { exact: true }).waitFor();
    }
    const freshPicker = replacement === "recognition" ? await choosePack() : await chooseTtsPack();
    await oldPicker.setFiles(ttsFixturePack);
    assert.equal(await button("Import selected TTS pack").count(), 0);
    await freshPicker.setFiles(replacement === "recognition" ? fixturePack : ttsFixturePack);
    await button(replacement === "recognition" ? "Import selected speech pack" : "Import selected TTS pack").waitFor();
    assert.equal(await page.evaluate(() => fixture.stats.preparations + fixture.stats.ttsPreparations), 0); checks++;
  }
  await reset(); const emptyPicker = await chooseTtsPack(); await emptyPicker.setFiles([]);
  assert.equal(await button("Import selected TTS pack").count(), 0);
  assert.equal(await page.evaluate(() => fixture.stats.ttsPreparations), 0); checks++;

  // Text-only manual approval and exact payload, full escaped text, navigation/catalog.
  await reset();
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.preparations), 0);
  assert.equal(await page.getByLabel("Enable English Heart playback", { exact: true }).isChecked(), false); checks++;
  await page.getByText("Text fallback and worker model catalog", { exact: true }).click();
  await button("Load available models").click();
  await page.waitForFunction(() => fixture.stats.requests.some(r => r.operation === "models"));
  await page.getByLabel("Worker model (empty = Pi default)").fill("test/model");
  await propose();
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;
  const exactText = await page.getByRole("article", { name: "Exact proposal" }).locator("pre").textContent();
  await button("Approve exact instruction").dblclick();
  await page.waitForFunction(() => fixture.stats.instructions === 1);
  const sent = await page.evaluate(() => fixture.stats.requests.find(r => r.operation === "execute").input.command);
  assert.equal(sent.prompt, exactText); assert.equal(sent.model, "test/model"); assert.equal(sent.kind, "start");
  assert.deepEqual(await page.evaluate(() => fixture.stats.requests.filter(r => r.operation === "arm").map(r => r.input)), [{ count: 1 }]); checks++;
  await button("Read text / question").click();
  await page.getByText("<img src=x onerror=alert('bad')> Escaped result", { exact: true }).waitFor();
  assert.equal(await page.locator("compn3rd-voice-panel img").count(), 0); checks++;
  await button("Open conversation").click();
  assert.equal(await page.evaluate(() => fixture.stats.navigations[0].sessionId), "exact-session"); checks++;
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width, JSON.stringify(dimensions)); checks++;

  // Mount/diagnostics/inspection must not allocate models, enable speech or create audio.
  await page.getByText("Local TTS diagnostics", { exact: true }).click();
  await button("Inspect TTS cache").click();
  const voiceDiagnostics = JSON.parse(await page.getByLabel("Local TTS diagnostics output").innerText());
  assert.equal(voiceDiagnostics.state, "unprepared");
  assert.equal(voiceDiagnostics.enabled, false);
  assert.equal(voiceDiagnostics.safe, true);
  assert.equal(await page.evaluate(() => fixture.stats.ttsRuntimes + fixture.stats.audioContexts + fixture.stats.spoken.length), 0); checks++;

  // Explicit preparation and enablement are independent; no OS voice APIs exist.
  assert.equal(await button("Speak result / question prefix").isEnabled(), false); checks++;
  await prepareTts();
  assert.equal(await button("Speak result / question prefix").isEnabled(), false);
  assert.equal(await page.evaluate(() => fixture.stats.audioContexts), 0);
  await enableTts();
  await page.evaluate(() => fixture.setResult("Long result " + "x".repeat(1500)));
  await button("Read text / question").click();
  await page.getByText("Playback is truncated: reads up to the first 1000 characters. Full text is shown above.", { exact: true }).waitFor();
  await button("Speak result / question prefix").click();
  assert.equal(await page.evaluate(() => fixture.stats.spoken[0].text.length), 1000);
  assert.equal(await page.evaluate(() => fixture.stats.spoken[0].voiceURI), "af_heart");
  assert.deepEqual(await page.evaluate(() => fixture.stats.resumedInGesture), [true]); checks++;
  await prepare();
  assert.equal(await page.evaluate(() => fixture.stats.captures), 0); checks++;
  await page.evaluate(() => { fixture.stats.pendingPermission = true; });
  await button("Start recording").click();
  await page.getByText("Requesting microphone permission for local capture…", { exact: true }).waitFor();
  assert.equal(await page.locator('.composer .badge').textContent(), "Opening microphone"); checks++;
  assert.equal(await page.evaluate(() => fixture.stats.speechCancels), 1);
  assert.equal(await button("Speak result / question prefix").isEnabled(), false); checks++;
  await page.evaluate(() => fixture.resolvePermission());
  await button("Finish recording").waitFor();
  assert.equal(await button("Finish recording").getAttribute("aria-pressed"), "true");
  assert.equal(await button("Speak worker status").isEnabled(), false); checks++;
  await page.evaluate(() => { fixture.stats.pendingTranscript = true; });
  await button("Finish recording").click();
  await page.getByText("Transcribing on this device · microphone off…", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.stops), 1);
  assert.equal(await button("Speak result / question prefix").isEnabled(), false); checks++;
  await page.evaluate(() => fixture.resolveTranscript("Dictated draft only"));
  await page.waitForFunction(() => document.querySelector("compn3rd-voice-panel").shadowRoot.querySelector("textarea").value === "Dictated draft only");
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 1);
  assert.equal(await page.getByRole("article", { name: "Exact proposal" }).count(), 0); checks++;
  // Hand back residency explicitly; no transcript/draft is lost and no speech is replayed.
  const spokenBeforeHandoff = await page.evaluate(() => fixture.stats.spoken.length);
  assert.equal(await button("Speak worker status").isEnabled(), false);
  await prepareTts();
  assert.equal(await prompt().inputValue(), "Dictated draft only");
  assert.equal(await button("Start recording").isEnabled(), false);
  assert.equal(await page.evaluate(() => fixture.stats.spoken.length), spokenBeforeHandoff);
  await enableTts(); await speakStatus();
  await button("Stop speaking").click();
  await page.waitForFunction(() => document.querySelector("compn3rd-voice-panel").speech?.state === "unprepared"); checks++;

  // Explicit settlement advances the stored revision before a successful reply.
  await settleWorker();
  await chooseReply();
  await unchangedDraft();
  await prompt().fill("Reply to exactly this worker");
  await button("Propose exact instruction").click();
  await page.getByRole("article", { name: "Exact proposal" }).getByText(/revision 2/).waitFor();
  await button("Approve exact instruction").click();
  await page.waitForFunction(() => fixture.stats.instructions === 2);
  const reply = await page.evaluate(() => fixture.stats.requests.filter(r => r.operation === "execute").at(-1).input.command);
  assert.equal(reply.kind, "reply"); assert.equal(reply.workerId, sent.requestId); assert.equal(reply.expectedRevision, 2); assert.equal(reply.model, undefined); checks++;
  await page.getByText("Worker revision changed · draft discarded. Select an exact target again.", { exact: true }).waitFor();
  await settleWorker(); await chooseReply(); await prompt().fill("Old revision draft"); await button("Propose exact instruction").click();
  await page.evaluate(() => fixture.bumpRevision()); await button("Refresh status").click();
  await page.getByText("Worker revision changed · draft discarded. Select an exact target again.", { exact: true }).waitFor();
  await unchangedDraft();

  // The fixture rejects running/unknown replies even when UI eligibility is bypassed.
  for (const status of ["running", "unknown"]) {
    await reset(); await createWorker();
    if (status === "unknown") {
      await page.evaluate(() => fixture.setWorkerStatus("unknown"));
      await button("Refresh status").click();
      await page.getByLabel("Instruction target").locator("option").last().filter({ hasText: "unknown" }).waitFor({ state: "attached" });
    }
    assert.equal(await page.getByLabel("Instruction target").locator("option").last().getAttribute("disabled"), "");
    const rejection = await page.evaluate(async () => {
      const [worker] = await fixture.request("list");
      let error = "";
      try {
        await fixture.request("execute", { command: { kind: "reply", requestId: crypto.randomUUID(), workerId: worker.id, expectedRevision: worker.revision, prompt: "Must reject" } });
      } catch (failure) { error = failure.message; }
      return { error, before: worker, after: (await fixture.request("list"))[0] };
    });
    assert.match(rejection.error, /busy or its state is unknown/);
    assert.equal(rejection.before.status, status);
    assert.deepEqual(rejection.after, rejection.before); checks++;
  }

  // Maximum-size PCM automatically finishes, but never dispatches.
  await reset(); await prepare(); await start();
  await page.evaluate(() => fixture.reachLimit());
  await page.getByText("Untrusted local transcript · edit and propose; nothing submitted", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.stops), 1);
  assert.equal(await page.evaluate(() => fixture.stats.transcriptions), 1);
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;
  await page.getByLabel("Title", { exact: true }).fill("Reviewed dictation");
  await prompt().fill("Corrected exact dictation");
  await button("Propose exact instruction").click();
  await page.getByRole("article", { name: "Exact proposal" }).waitFor();
  await prompt().fill("Final corrected dictation");
  assert.equal(await page.getByRole("article", { name: "Exact proposal" }).count(), 0);
  await button("Propose exact instruction").click(); await button("Approve exact instruction").click();
  await page.waitForFunction(() => fixture.stats.instructions === 1);
  assert.equal(await page.evaluate(() => fixture.stats.requests.find(r => r.operation === "execute").input.command.prompt), "Final corrected dictation"); checks++;

  // Cancellation at each asynchronous boundary fences late results and requires prepare again.
  for (const boundary of ["prepare", "permission", "transcript"]) {
    for (const cancellation of ["off", "context", "hide", "unmount"]) {
      await reset();
      if (boundary === "prepare") {
        await page.evaluate(() => { fixture.stats.pendingPrepare = true; });
        await button("Prepare local English speech pack").click();
        await page.getByText("Loading local pack · fixture 50%", { exact: true }).waitFor();
      } else {
        await prepare();
        if (boundary === "permission") {
          await page.evaluate(() => { fixture.stats.pendingPermission = true; });
          await button("Start recording").click();
          await page.getByText("Requesting microphone permission for local capture…", { exact: true }).waitFor();
        } else {
          await start(); await page.evaluate(() => { fixture.stats.pendingTranscript = true; });
          await button("Finish recording").click();
          await page.getByText("Transcribing on this device · microphone off…", { exact: true }).waitFor();
        }
      }
      if (cancellation === "off") await button("Cancel / voice off").click();
      else if (cancellation === "context") await page.evaluate(() => fixture.mount("workspace-b"));
      else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
      else await page.evaluate(() => fixture.unmount());
      await page.evaluate(boundary => {
        if (boundary === "prepare") fixture.resolvePrepare();
        else if (boundary === "permission") fixture.resolvePermission();
        else fixture.resolveTranscript();
      }, boundary);
      if (boundary === "permission") await page.waitForFunction(() => fixture.stats.stops === 1);
      if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(false));
      if (cancellation === "unmount") await page.evaluate(() => fixture.mount());
      await unchangedDraft();
      await page.waitForFunction(() => !document.querySelector("compn3rd-voice-panel").stopping);
      assert.equal(await button("Start recording").isEnabled(), false);
      assert.equal(await button("Prepare local English speech pack").isEnabled(), true);
      assert.equal(await page.evaluate(() => fixture.stats.instructions), 0);
      assert.equal(await page.getByText("Late pack progress", { exact: true }).count(), 0);
      assert.ok(await page.evaluate(() => fixture.stats.disarms.includes("workspace-a"))); checks++;
    }
  }

  // Target/model changes during inference invalidate the captured target, never rebind.
  for (const selection of ["target", "model", "session"]) {
    await reset(); await createWorker(); await settleWorker(); await prepare(); await start();
    await page.evaluate(() => { fixture.stats.pendingTranscript = true; });
    await button("Finish recording").click();
    await page.getByText("Transcribing on this device · microphone off…", { exact: true }).waitFor();
    if (selection === "target") await chooseReply();
    else if (selection === "model") await page.getByLabel("Worker model (empty = Pi default)").fill("test/other");
    else await page.evaluate(() => fixture.mount("workspace-a", "different-session"));
    await page.evaluate(() => fixture.resolveTranscript());
    await unchangedDraft();
    assert.equal(await page.evaluate(() => fixture.stats.instructions), 1); checks++;
  }

  // A polled revision change also cancels an in-flight utterance bound to that reply.
  await reset(); await createWorker(); await settleWorker(); await chooseReply(); await prepare(); await start();
  await page.evaluate(() => { fixture.stats.pendingTranscript = true; });
  await button("Finish recording").click();
  await page.getByText("Transcribing on this device · microphone off…", { exact: true }).waitFor();
  await page.evaluate(() => fixture.bumpRevision()); await button("Refresh status").click();
  await page.getByText("Worker revision changed · draft discarded. Select an exact target again.", { exact: true }).waitFor();
  await page.evaluate(() => fixture.resolveTranscript()); await unchangedDraft();
  assert.equal(await button("Start recording").isEnabled(), false);
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 1); checks++;

  // Exact one-shot approval issuance is fenced by old context/permission epochs.
  for (const cancellation of ["off", "context", "hide", "unmount", "target"]) {
    await reset(); await propose();
    await page.evaluate(() => { fixture.stats.pendingArm = true; });
    await button("Approve exact instruction").click();
    await page.waitForFunction(() => fixture.stats.requests.some(r => r.operation === "arm"));
    if (cancellation === "off") await button("Cancel / voice off").click();
    else if (cancellation === "context") await page.evaluate(() => fixture.mount("workspace-b"));
    else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
    else if (cancellation === "target") await page.getByLabel("Instruction target").selectOption("");
    else await page.evaluate(() => fixture.unmount());
    await page.evaluate(() => fixture.resolveArm());
    await page.waitForFunction(() => fixture.stats.requests.some(r => r.operation === "disarm" && r.input.token === "fixture-token-1"));
    const revoked = await page.evaluate(() => fixture.stats.requests.find(r => r.operation === "disarm" && r.input.token));
    assert.equal(revoked.workspaceId, "workspace-a");
    assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;
  }

  // Uncertain delivery consumes the proposal and never retries the mutation.
  await reset(); await propose(); await page.evaluate(() => { fixture.stats.failExecute = true; });
  await button("Approve exact instruction").click();
  await page.getByRole("alert").filter({ hasText: "Instruction outcome may be unknown" }).waitFor();
  assert.equal(await button("Approve exact instruction").count(), 0);
  await button("Refresh status").click();
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 1); checks++;

  // Unsupported/insecure capture fails locally, text fallback remains usable.
  for (const unsupported of ["media", "https"]) {
    await reset(); await prepare();
    await page.evaluate(kind => kind === "media" ? fixture.setMediaSupported(false) : fixture.setSecureContext(false), unsupported);
    await button("Start recording").click();
    await page.getByRole("alert").filter({ hasText: "Local microphone capture requires HTTPS" }).waitFor();
    assert.equal(await button("Start recording").isEnabled(), false);
    assert.equal(await button("Prepare local English speech pack").isEnabled(), true);
    await propose(); assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;
  }

  // Active capture and active playback are canceled by off/hide/unmount/context.
  for (const cancellation of ["off", "hide", "unmount", "context"]) {
    await reset(); await prepare(); await start();
    if (cancellation === "off") await button("Cancel / voice off").click();
    else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
    else if (cancellation === "unmount") await page.evaluate(() => fixture.unmount());
    else await page.evaluate(() => fixture.mount("workspace-b"));
    await page.waitForFunction(() => fixture.stats.stops === 1);
    assert.equal(await page.evaluate(() => fixture.stats.transcriptions), 0); checks++;
    await reset(); await createWorker();
    await prepareTts(); await enableTts();
    await speakStatus();
    if (cancellation === "off") await button("Cancel / voice off").click();
    else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
    else if (cancellation === "unmount") await page.evaluate(() => fixture.unmount());
    else await page.evaluate(() => fixture.mount("workspace-b"));
    await page.waitForFunction(() => fixture.stats.speechCancels === 1);
    await page.evaluate(() => fixture.lateSpeechEnd());
    assert.equal(await page.getByText("Speech finished", { exact: true }).count(), 0); checks++;
    if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(false));
    if (cancellation === "unmount") await page.evaluate(() => fixture.mount());
    await prepare(); await start();
    assert.equal(await page.evaluate(() => fixture.stats.captures), 1); checks++;
  }
  // Failed page-global cancellation survives every output owner lifecycle. Late
  // callbacks and fresh wrappers cannot authorize preparation, capture or playback.
  for (const cancellation of ["off", "target", "model", "context", "session", "revision", "hide", "remount"]) {
    await reset(); await createWorker(); await settleWorker();
    if (cancellation === "revision") await chooseReply();
    await prepare();
    await prepareTts(); await enableTts();
    await speakStatus();
    await page.evaluate(() => { fixture.stats.failSpeechCancel = true; });
    if (cancellation === "off") await button("Cancel / voice off").click();
    else if (cancellation === "target") await chooseReply();
    else if (cancellation === "model") await page.getByLabel("Worker model (empty = Pi default)").fill("test/other");
    else if (cancellation === "context") await page.evaluate(() => fixture.mount("workspace-b"));
    else if (cancellation === "session") await page.evaluate(() => fixture.mount("workspace-a", "different-session"));
    else if (cancellation === "revision") { await page.evaluate(() => fixture.bumpRevision()); await button("Refresh status").click(); }
    else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
    else await page.evaluate(() => fixture.unmount());
    await page.waitForFunction(() => fixture.stats.speechCancels === 1);
    await page.evaluate(() => fixture.lateSpeechEnd());
    if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(false));
    if (cancellation === "remount") await page.evaluate(() => fixture.mount());
    await page.getByText(/Audio teardown is uncertain/).first().waitFor();
    assert.equal(await page.locator('.composer .badge').textContent(), "Microphone state uncertain · reload required"); checks++;
    assert.equal(await button("Prepare local English speech pack").isEnabled(), false);
    assert.equal(await button("Start recording").isEnabled(), false);
    assert.equal(await button("Speak worker status").isEnabled(), false);
    // Exercise handlers too: a disabled control is not the safety boundary.
    const preparationError = await page.evaluate(async () => {
      const panel = document.querySelector("compn3rd-voice-panel");
      let error = "";
      try { await panel.prepare(); } catch (failure) { error = failure.message; }
      await panel.toggleRecording();
      panel.speak("status");
      return error;
    });
    assert.match(preparationError, /Audio teardown is uncertain/);
    await button("Stop speaking").click();
    assert.equal(await page.evaluate(() => fixture.stats.captures), 0);
    assert.equal(await page.evaluate(() => fixture.stats.preparations), 1);
    assert.equal(await page.evaluate(() => fixture.stats.spoken.length), 1);
    assert.equal(await page.getByText("Speech canceled.", { exact: true }).count(), 0); checks++;
  }
  // Recognition cannot claim residency when stopping TTS leaves audio uncertain.
  await reset(); await createWorker(); await prepareTts(); await enableTts(); await speakStatus();
  await page.evaluate(() => { fixture.stats.failSpeechCancel = true; });
  await button("Prepare local English speech pack").click();
  await page.getByText(/Audio teardown is uncertain/).first().waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.captures), 0);
  assert.equal(await button("Start recording").isEnabled(), false);
  assert.equal(await button("Prepare cached TTS pack").isEnabled(), false); checks++;

  // Reload is the documented recovery boundary, not another panel mount.
  await reset(); await createWorker();
  await prepareTts(); await enableTts();
  await speakStatus();
  await prepare(); await start();
  assert.equal(await page.evaluate(() => fixture.stats.captures), 1);
  assert.equal(await page.evaluate(() => fixture.stats.speechCancels), 1); checks++;

  // Same-scope reads must not overwrite a newer result or reopen closed details.
  await reset(); await createWorker();
  await page.evaluate(() => { fixture.stats.pendingRead = true; fixture.setResult("Older read"); });
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.filter(r => r.operation === "read").length === 1);
  await page.evaluate(() => fixture.setResult("Newer read"));
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.filter(r => r.operation === "read").length === 2);
  await page.evaluate(() => fixture.resolveRead(1));
  await page.getByText("Newer read", { exact: true }).waitFor();
  await page.evaluate(async () => { fixture.resolveRead(); await new Promise(requestAnimationFrame); });
  assert.equal(await page.getByText("Newer read", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Older read", { exact: true }).count(), 0); checks++;

  await page.evaluate(() => { fixture.stats.pendingRead = true; fixture.setResult("Closed pending read"); });
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.filter(r => r.operation === "read").length === 3);
  await button("Close detail").click();
  await page.evaluate(async () => { fixture.resolveRead(); await new Promise(requestAnimationFrame); });
  assert.equal(await button("Close detail").count(), 0);
  assert.equal(await page.getByText("Closed pending read", { exact: true }).count(), 0); checks++;

  // A revision change invalidates result playback even when replying to New task.
  await reset(); await createWorker();
  await button("Read text / question").click();
  await button("Close detail").waitFor();
  await prepareTts(); await enableTts();
  await prepareTts(); await speakResult();
  await page.evaluate(() => fixture.bumpRevision());
  await button("Refresh status").click();
  await page.waitForFunction(() => fixture.stats.speechCancels === 1);
  assert.equal(await button("Close detail").count(), 0); checks++;

  await page.evaluate(() => { fixture.stats.pendingRead = true; fixture.setResult("Obsolete revision"); });
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.filter(r => r.operation === "read").length === 2);
  await page.evaluate(() => fixture.bumpRevision());
  await button("Refresh status").click();
  await page.getByLabel("Instruction target").locator("option").last().filter({ hasText: "revision 3" }).waitFor({ state: "attached" });
  await page.evaluate(async () => { fixture.resolveRead(); await new Promise(requestAnimationFrame); });
  assert.equal(await page.getByText("Obsolete revision", { exact: true }).count(), 0); checks++;

  // Off clears displayed results as well as pending reads and audio.
  await reset(); await createWorker();
  await button("Read text / question").click();
  await button("Close detail").waitFor();
  await button("Cancel / voice off").click();
  assert.equal(await button("Close detail").count(), 0); checks++;

  // Playback started while a replacement read is pending must stop when it arrives.
  await reset(); await createWorker();
  await page.evaluate(() => fixture.setResult("Displayed old result"));
  await button("Read text / question").click();
  await page.getByText("Displayed old result", { exact: true }).waitFor();
  await prepareTts(); await enableTts();
  await page.evaluate(() => { fixture.stats.pendingRead = true; fixture.setResult("Replacement result"); });
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.filter(r => r.operation === "read").length === 2);
  await prepareTts(); await speakResult();
  assert.equal(await page.evaluate(() => fixture.stats.spoken.at(-1).text), "workspace-a. Worker 1, Fixture task. Working. Displayed old result");
  await page.evaluate(() => fixture.resolveRead());
  await page.getByText("Replacement result", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.speechCancels), 1);
  await page.evaluate(() => fixture.lateSpeechEnd());
  assert.equal(await page.getByText("Speech finished", { exact: true }).count(), 0); checks++;

  // The playback prefix retains whole surrogate pairs at the character limit.
  await reset(); await createWorker();
  await prepareTts(); await enableTts();
  const intro = "workspace-a. Worker 1, Fixture task. Working. ";
  const budget = 1000 - intro.length;
  for (const [value, expected] of [
    ["x".repeat(budget - 1) + "😀tail", "x".repeat(budget - 1)],
    ["x".repeat(budget - 2) + "😀tail", "x".repeat(budget - 2) + "😀"],
    ["x".repeat(1001), "x".repeat(budget)],
    ["Short 😀", "Short 😀"],
  ]) {
    await page.evaluate(value => fixture.setResult(value), value);
    await button("Read text / question").click();
    await page.getByText(value, { exact: true }).waitFor();
    await prepareTts(); await speakResult();
    assert.equal(await page.evaluate(() => fixture.stats.spoken.at(-1).text), intro + expected); checks++;
  }

  // A later chunk failure is visibly partial, never labelled complete or replayed.
  await reset(); await createWorker(); await prepareTts(); await enableTts();
  await page.evaluate(() => { fixture.stats.ttsChunkCount = 2; fixture.stats.failChunkAt = 1; });
  await speakStatus();
  await page.getByText("Partial playback · remaining text was not spoken; prepare explicitly to retry", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.spoken.length), 1);
  assert.equal(await button("Speak worker status").isEnabled(), false);
  await page.evaluate(() => fixture.lateSpeechEnd());
  assert.equal(await page.getByText("Speech finished", { exact: true }).count(), 0); checks++;

  // All asynchronous TTS phases lose source/permission authority on lifecycle changes.
  for (const boundary of ["prepare", "plan", "chunk", "resume"]) {
    for (const cancellation of ["off", "hide", "remount", "context"]) {
      await reset(); await createWorker();
      if (boundary === "prepare") {
        await page.evaluate(() => { fixture.stats.pendingTtsPrepare = true; });
        await button("Prepare cached TTS pack").click();
        await page.waitForFunction(() => fixture.stats.ttsPreparations === 1);
      } else {
        await prepareTts(); await enableTts();
        await page.evaluate(boundary => { fixture.stats[{ plan: "pendingPlan", chunk: "pendingChunk", resume: "pendingResume" }[boundary]] = true; }, boundary);
        await button("Speak worker status").click();
        await page.waitForFunction(boundary => boundary === "plan" ? fixture.stats.ttsPlans.length === 1 : boundary === "chunk" ? fixture.stats.ttsChunks === 1 : fixture.stats.resumedInGesture.length === 1, boundary);
      }
      if (cancellation === "off") await button("Cancel / voice off").click();
      else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
      else if (cancellation === "remount") await page.evaluate(() => fixture.unmount());
      else await page.evaluate(() => fixture.mount("workspace-b"));
      await page.evaluate(boundary => {
        fixture[{ prepare: "resolveTtsPrepare", plan: "resolvePlan", chunk: "resolveChunk", resume: "resolveResume" }[boundary]]();
      }, boundary);
      if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(false));
      if (cancellation === "remount") await page.evaluate(() => fixture.mount());
      await page.waitForFunction(() => !document.querySelector("compn3rd-voice-panel").stopping);
      assert.equal(await page.evaluate(() => fixture.stats.spoken.length), 0);
      assert.equal(await button("Speak worker status").isEnabled(), false);
      assert.equal(await page.getByLabel("Enable English Heart playback", { exact: true }).isChecked(), false);
      assert.equal(await page.evaluate(() => fixture.stats.instructions), 1); checks++;
    }
  }

  // Exact-cache deletion retains exclusion until active audio has safely closed.
  await reset(); await createWorker(); await prepareTts(); await enableTts(); await speakStatus();
  await page.evaluate(async names => { for (const name of names) await caches.open(name); fixture.stats.pendingClose = true; }, [packInfo.tts.cacheName, packInfo.recognition.cacheName, "unrelated-cache"]);
  await button("Clear TTS cache").click();
  await page.waitForFunction(() => fixture.stats.audioCloses === 1);
  assert.ok((await page.evaluate(() => caches.keys())).includes(packInfo.tts.cacheName));
  assert.equal(await button("Prepare local English speech pack").isEnabled(), false);
  await page.evaluate(() => fixture.resolveClose());
  await page.waitForFunction(name => caches.has(name).then(present => !present), packInfo.tts.cacheName);
  assert.deepEqual((await page.evaluate(() => caches.keys())).sort(), [packInfo.recognition.cacheName, "unrelated-cache"].sort());
  assert.equal(await page.getByLabel("Enable English Heart playback", { exact: true }).isChecked(), false); checks++;
  await prepare();
  await button("Clear TTS cache").click();
  await page.waitForFunction(() => !document.querySelector("compn3rd-voice-panel").cacheAction);
  assert.equal(await button("Start recording").isEnabled(), true);
  assert.equal(await page.evaluate(() => fixture.stats.captures), 0); checks++;

  // BFCache transitions require explicit preparation and enablement again.
  await reset(); await createWorker(); await prepareTts(); await enableTts(); await speakStatus();
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
  await page.waitForFunction(() => !document.querySelector("compn3rd-voice-panel").stopping);
  assert.equal(await button("Speak worker status").isEnabled(), false);
  assert.equal(await page.getByLabel("Enable English Heart playback", { exact: true }).isChecked(), false);
  assert.equal(await page.evaluate(() => fixture.stats.spoken.length), 1); checks++;

  // Pending full-text read cannot populate a different workspace.
  await reset(); await createWorker();
  await page.evaluate(() => { fixture.stats.pendingRead = true; });
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.some(r => r.operation === "read"));
  await page.evaluate(() => fixture.mount("workspace-b"));
  await page.getByText("No tracked workers in this workspace.", { exact: true }).waitFor();
  await page.evaluate(() => fixture.resolveRead());
  assert.equal(await page.getByText("<img src=x onerror=alert('bad')> Escaped result", { exact: true }).count(), 0); checks++;
  // Voice-first path needs no keyboard: optional pause ending, suggested title, still two exact taps.
  await reset();
  await page.getByText("Speech setup & storage", { exact: true }).click();
  assert.equal(await button("Download pinned TTS pack").isVisible(), false);
  assert.equal(await button("Prepare local English speech pack").isVisible(), true);
  assert.equal(await button("Start recording").isVisible(), true);
  await prepare(); await page.getByLabel("Finish on a pause · draft only", { exact: true }).check(); await start();
  await page.evaluate(() => fixture.pause());
  await page.waitForFunction(() => fixture.stats.transcriptions === 1);
  await page.waitForFunction(() => document.querySelector("compn3rd-voice-panel").transcript.length > 0);
  assert.equal(await page.evaluate(() => fixture.stats.captures), 1);
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0);
  await button("Propose exact instruction").click();
  await page.getByRole("article", { name: "Exact proposal" }).getByRole("heading", { name: /Proposed Dictated instruction/ }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0);
  await button("Approve exact instruction").click();
  await page.getByLabel("Instruction receipt", { exact: true }).getByText("Instruction admitted", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.requests.find(r => r.operation === "execute").input.command.title), "Dictated instruction, never automatic approval");
  checks++;

  // Further utterances add to the same exact draft, not a fresh command or implicit send.
  await reset(); await prompt().fill("Keep my first thought."); await prepare(); await start();
  await button("Finish recording").click();
  await page.waitForFunction(() => document.querySelector("compn3rd-voice-panel").transcript.includes("Dictated"));
  assert.equal(await prompt().inputValue(), "Keep my first thought.\n\nDictated instruction, never automatic approval");
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0);
  await prompt().fill("x".repeat(16000)); await start(); await button("Finish recording").click();
  await page.getByRole("alert").filter({ hasText: "existing draft is unchanged" }).waitFor();
  assert.equal((await prompt().inputValue()).length, 16000); checks++;

  // Duplicate titles remain separate identities; a question shortcut binds its exact fresh revision.
  await reset();
  await page.evaluate(() => fixture.seedWorkers([
    { question: "Which color for the header?" }, { question: "Which database should I use?" }, { status: "unknown" },
  ]));
  await button("Refresh status").click();
  await page.getByText("3 updates to review", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.stats.requests.filter(r => r.operation === "read").length), 0);
  await prompt().fill("A draft for someone else");
  const second = page.getByRole("article", { name: "Worker 2: Same title", exact: true });
  await second.getByRole("button", { name: "Review and reply", exact: true }).click();
  await page.getByText("Answering this saved question", { exact: true }).waitFor();
  assert.equal(await prompt().inputValue(), "");
  assert.equal(await page.getByLabel("Instruction target").inputValue(), "11111111-1111-4111-8111-000000000002:1");
  assert.match(await page.getByRole("region", { name: "Exact instruction", exact: true }).innerText(), /Which database should I use/);
  assert.equal(await page.evaluate(() => document.querySelector("compn3rd-voice-panel").shadowRoot.activeElement?.tagName), "H3");
  await prompt().fill("Use SQLite, and keep the existing data."); await button("Propose exact instruction").click();
  await button("Approve exact instruction").click();
  await page.waitForFunction(() => fixture.stats.instructions === 1);
  assert.equal(await page.evaluate(() => fixture.stats.requests.find(r => r.operation === "execute").input.command.workerId), "11111111-1111-4111-8111-000000000002");
  checks++;

  // Polling never steals a draft/focus or reads/speaks results; reviewed revisions do not acknowledge workers.
  await reset(); await prompt().fill("Still composing a different task");
  await page.evaluate(() => fixture.seedWorkers([{ status: "completed" }, { question: "Choose the migration?" }]));
  await button("Refresh status").click(); await page.getByText("2 updates to review", { exact: true }).waitFor();
  await prompt().focus();
  await page.evaluate(() => document.querySelector("compn3rd-voice-panel").refresh());
  assert.equal(await page.evaluate(() => document.querySelector("compn3rd-voice-panel").shadowRoot.activeElement?.tagName), "TEXTAREA");
  assert.equal(await prompt().inputValue(), "Still composing a different task");
  assert.equal(await page.evaluate(() => fixture.stats.spoken.length + fixture.stats.requests.filter(r => r.operation === "read").length), 0);
  await button("Review next update").click();
  await page.getByRole("article", { name: "Worker detail", exact: true }).getByText("Choose the migration?", { exact: true }).waitFor();
  await button("Mark reviewed").click(); await page.getByText("1 updates to review", { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await fixture.request("list"))[1].status), "needs-input");
  await button("Review next update").click(); await button("Mark reviewed").click();
  await page.getByText("0 updates to review", { exact: true }).waitFor();
  await page.evaluate(() => fixture.bumpRevision()); await button("Refresh status").click();
  await page.getByText("1 updates to review", { exact: true }).waitFor();
  await page.evaluate(() => fixture.mount("workspace-b"));
  await page.getByText("0 updates to review", { exact: true }).waitFor(); checks++;

  // A pending shortcut cannot bind stale worker state, nor cross context after its read.
  for (const change of ["revision", "context"]) {
    await reset(); await page.evaluate(() => fixture.seedWorkers([{ question: "Old question?" }]));
    await button("Refresh status").click(); await button("Review and reply").waitFor();
    await page.evaluate(() => { fixture.stats.pendingRead = true; });
    await button("Review and reply").click();
    await page.waitForFunction(() => fixture.stats.requests.some(r => r.operation === "read"));
    if (change === "revision") { await page.evaluate(() => fixture.bumpRevision()); await button("Refresh status").click(); }
    else { await page.evaluate(() => fixture.mount("workspace-b")); await page.getByText("No tracked workers in this workspace.", { exact: true }).waitFor(); }
    await page.evaluate(async () => { fixture.resolveRead(); await new Promise(requestAnimationFrame); });
    assert.equal(await page.getByLabel("Instruction target").inputValue(), "new");
    assert.equal(await page.getByText("Answering this saved question", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;
  }

  // Briefings distinguish same-title workers, prioritize attention, and preview exactly what is spoken.
  await reset(); await page.evaluate(() => fixture.seedWorkers([{ status: "running" }, { question: "Private question" }]));
  await button("Refresh status").click(); await prepareTts(); await enableTts(); await speakStatus();
  const briefing = await page.evaluate(() => fixture.stats.spoken.at(-1).text);
  assert.match(briefing, /^workspace-a\./);
  assert.ok(briefing.indexOf("Worker 2, Same title: Needs your answer") < briefing.indexOf("Worker 1, Same title: Working"));
  assert.ok(!briefing.includes("Private question"));
  await page.getByText(/^Exact status playback prefix/).click();
  assert.equal(await page.getByRole("region", { name: "Model speech playback", exact: true }).locator("pre").innerText(), briefing);
  assert.equal(await page.evaluate(() => fixture.stats.requests.filter(r => r.operation === "read").length), 0); checks++;

  // Lost status shows stale snapshots explicitly. A consumed uncertain instruction has no replay UI.
  await reset(); await createWorker();
  await page.evaluate(() => { fixture.stats.failList = true; }); await button("Refresh status").click();
  await page.getByText("Status unavailable · showing the last snapshot, not live state.", { exact: true }).waitFor();
  await page.evaluate(() => { fixture.stats.failList = false; }); await button("Refresh status").click();
  await page.waitForFunction(() => !document.querySelector("compn3rd-voice-panel").refreshError);
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 1); checks++;
  await reset(); await propose(); await page.evaluate(() => { fixture.stats.failExecute = true; });
  await button("Approve exact instruction").click();
  await page.getByLabel("Instruction receipt", { exact: true }).getByText("Delivery uncertain", { exact: true }).waitFor();
  assert.equal(await prompt().inputValue(), "");
  assert.equal(await button("Propose exact instruction").isEnabled(), false);
  assert.equal(await button("Approve exact instruction").count(), 0); checks++;

  // Compact default at narrow phone width, with all critical controls keyboard reachable.
  await reset(); await page.getByText("Speech setup & storage", { exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByLabel("Instruction target").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.querySelector("compn3rd-voice-panel").shadowRoot.activeElement?.textContent), "Prepare local English speech pack");
  await page.setViewportSize({ width: 390, height: 844 }); checks++;

  // A newer detail invalidates captured reply authority immediately; late list cannot roll it back.
  await reset(); await page.evaluate(() => fixture.seedWorkers([{ question: "Original question?" }]));
  await button("Refresh status").click(); await chooseReply(); await prepare(); await start();
  await page.evaluate(() => { fixture.stats.pendingTranscript = true; }); await button("Finish recording").click();
  await page.getByText("Transcribing on this device · microphone off…", { exact: true }).waitFor();
  const listCount = await page.evaluate(() => fixture.stats.requests.filter(r => r.operation === "list").length);
  await page.evaluate(() => { fixture.stats.pendingList = true; }); await button("Refresh status").click();
  await page.waitForFunction(count => fixture.stats.requests.filter(r => r.operation === "list").length > count, listCount);
  await page.evaluate(() => fixture.bumpRevision()); await button("Read selected worker context").click();
  await page.getByText("Worker revision changed · draft discarded. Select an exact target again.", { exact: true }).waitFor();
  await page.evaluate(async () => { fixture.resolveList(); fixture.resolveTranscript("Obsolete answer"); await new Promise(requestAnimationFrame); });
  assert.equal(await page.evaluate(() => document.querySelector("compn3rd-voice-panel").workers[0].revision), 2);
  assert.equal(await prompt().inputValue(), "");
  assert.equal(await page.getByLabel("Instruction target").inputValue(), "");
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;

  // An active spoken status preview remains the exact captured text when local review state changes.
  await reset(); await page.evaluate(() => fixture.seedWorkers([{ question: "Question?" }]));
  await button("Refresh status").click(); await button("Read text / question").click();
  await prepareTts(); await enableTts(); await speakStatus();
  const capturedStatus = await page.evaluate(() => fixture.stats.spoken.at(-1).text);
  await button("Mark reviewed").click(); await page.getByText("0 updates to review", { exact: true }).waitFor();
  await page.getByText(/^Exact status playback prefix/).click();
  assert.equal(await page.getByRole("region", { name: "Model speech playback", exact: true }).locator("pre").innerText(), capturedStatus);
  assert.equal(await page.evaluate(() => fixture.stats.spoken.length), 1); checks++;

  await reset(); await page.evaluate(() => fixture.seedWorkers([{ status: "running" }, { status: "starting" }, { status: "unknown" }]));
  await button("Refresh status").click(); await prompt().fill("Keep this draft until a slot opens");
  assert.equal(await button("Propose exact instruction").isEnabled(), false);
  assert.match(await page.getByRole("region", { name: "Exact instruction", exact: true }).innerText(), /All three active or uncertain slots/);
  assert.equal(await page.evaluate(() => fixture.stats.instructions), 0); checks++;

  assert.deepEqual(errors, []); assert.deepEqual(blockedNetwork, []); checks++;
  console.log(`Browser fixture: ${checks} checks passed (real LocalRecognizer with fake PCM/runtime, real model output controller with fake Web Audio/TTS runtime and host, mobile viewport, all networking intercepted; no model downloads or live acceptance).`);
} finally { await browser.close(); }
