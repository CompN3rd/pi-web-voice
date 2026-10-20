import { chromium } from "playwright-core";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const output = await build({
  entryPoints: ["test/browser-fixture.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  plugins: [{ name: "fixture-local-recognizer", setup(build) {
    build.onResolve({ filter: /^\.\/audio\.ts$/ }, args => args.importer.replaceAll("\\", "/").endsWith("/src/browser/index.ts")
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
  const reset = async () => { await page.goto("http://localhost:43119/"); await page.getByText("No tracked workers in this workspace.").waitFor(); };
  const prepare = async () => { await button("Prepare local English speech pack").click(); await page.getByText("Local speech ready · audio stays on this device", { exact: true }).waitFor(); };
  const start = async () => { await button("Start recording").click(); await page.getByText("Listening locally · finish within 20 seconds", { exact: true }).waitFor(); };
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

  // Text-only manual approval and exact payload, full escaped text, navigation/catalog.
  await reset();
  assert.equal(await page.evaluate(() => fixture.stats.captures + fixture.stats.preparations), 0);
  assert.equal(await page.getByLabel("Local English voice").inputValue(), ""); checks++;
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

  // Explicit local voice only, bounded playback, and half duplex across capture/inference.
  assert.deepEqual(await page.getByLabel("Local English voice").locator("option").allTextContents(), ["Text only · select a voice explicitly", "Local English (en-US)"]);
  assert.equal(await button("Speak result / question prefix").isEnabled(), false); checks++;
  await page.getByLabel("Local English voice").selectOption("Local English");
  await page.evaluate(() => fixture.setResult("Long result " + "x".repeat(1500)));
  await button("Read text / question").click();
  await page.getByText("Playback is truncated: reads only the first 1000 characters. Full text is shown above.", { exact: true }).waitFor();
  await button("Speak result / question prefix").click();
  assert.equal(await page.evaluate(() => fixture.stats.spoken[0].text.length), 1000);
  assert.equal(await page.evaluate(() => fixture.stats.spoken[0].voiceURI), "Local English"); checks++;
  await prepare();
  assert.equal(await page.evaluate(() => fixture.stats.captures), 0); checks++;
  await page.evaluate(() => { fixture.stats.pendingPermission = true; });
  await button("Start recording").click();
  await page.getByText("Requesting microphone permission for local capture…", { exact: true }).waitFor();
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
  await page.evaluate(() => fixture.removeLocalVoices());
  await page.getByText("Text only: selected local English voice is no longer available. Select a voice again.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Local English voice").inputValue(), ""); checks++;

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
    await page.getByLabel("Local English voice").selectOption("Local English");
    await button("Speak worker status").click();
    if (cancellation === "off") await button("Cancel / voice off").click();
    else if (cancellation === "hide") await page.evaluate(() => fixture.setHidden(true));
    else if (cancellation === "unmount") await page.evaluate(() => fixture.unmount());
    else await page.evaluate(() => fixture.mount("workspace-b"));
    await page.waitForFunction(() => fixture.stats.speechCancels === 1);
    await page.evaluate(() => fixture.lateSpeechEnd());
    assert.equal(await page.getByText("Local speech finished.", { exact: true }).count(), 0); checks++;
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
    await page.getByLabel("Local English voice").selectOption("Local English");
    await button("Speak worker status").click();
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
    await page.getByText(/Speech cancellation failed.*audio may still be playing/).first().waitFor();
    assert.equal(await button("Prepare local English speech pack").isEnabled(), false);
    assert.equal(await button("Start recording").isEnabled(), false);
    assert.equal(await button("Speak worker status").isEnabled(), false);
    // Exercise handlers too: a disabled control is not the safety boundary.
    const preparationError = await page.evaluate(async () => {
      const panel = document.querySelector("compn3rd-voice-panel");
      let error = "";
      try { await panel.prepare(); } catch (failure) { error = failure.message; }
      await panel.toggleRecording();
      panel.speak("Must stay silent");
      return error;
    });
    assert.match(preparationError, /Speech cancellation failed/);
    await button("Stop speaking").click();
    assert.equal(await page.evaluate(() => fixture.stats.captures), 0);
    assert.equal(await page.evaluate(() => fixture.stats.preparations), 1);
    assert.equal(await page.evaluate(() => fixture.stats.spoken.length), 1);
    assert.equal(await page.getByText("Local speech canceled.", { exact: true }).count(), 0); checks++;
  }
  // Cancellation can also fail at the capture boundary with an already-ready
  // recognizer: structured safety, not a status string, must prevent openCapture.
  await reset(); await createWorker(); await prepare();
  await page.getByLabel("Local English voice").selectOption("Local English");
  await button("Speak worker status").click();
  await page.evaluate(() => { fixture.stats.failSpeechCancel = true; });
  await button("Start recording").click();
  await page.getByRole("alert").filter({ hasText: "Speech cancellation failed" }).waitFor();
  const captureError = await page.evaluate(async () => {
    try { await document.querySelector("compn3rd-voice-panel").toggleRecording(); }
    catch (failure) { return failure.message; }
  });
  assert.match(captureError, /Speech cancellation failed/);
  assert.equal(await page.evaluate(() => fixture.stats.captures), 0);
  assert.equal(await button("Start recording").isEnabled(), false); checks++;

  // Reload is the documented recovery boundary, not another panel mount.
  await reset(); await createWorker();
  await page.getByLabel("Local English voice").selectOption("Local English");
  await button("Speak worker status").click();
  await prepare(); await start();
  assert.equal(await page.evaluate(() => fixture.stats.captures), 1);
  assert.equal(await page.evaluate(() => fixture.stats.speechCancels), 1); checks++;

  // Pending full-text read cannot populate a different workspace.
  await reset(); await createWorker();
  await page.evaluate(() => { fixture.stats.pendingRead = true; });
  await button("Read text / question").click();
  await page.waitForFunction(() => fixture.stats.requests.some(r => r.operation === "read"));
  await page.evaluate(() => fixture.mount("workspace-b"));
  await page.getByText("No tracked workers in this workspace.").waitFor();
  await page.evaluate(() => fixture.resolveRead());
  assert.equal(await page.getByText("<img src=x onerror=alert('bad')> Escaped result", { exact: true }).count(), 0); checks++;
  assert.deepEqual(errors, []); assert.deepEqual(blockedNetwork, []); checks++;
  console.log(`Browser fixture: ${checks} checks passed (real LocalRecognizer with fake PCM/runtime, fake local synthesis/host, mobile viewport, all networking intercepted; no model downloads or live acceptance).`);
} finally { await browser.close(); }
