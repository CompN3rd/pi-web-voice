import test from "node:test";
import assert from "node:assert/strict";
import { LocalSpeechOutput, type LocalSpeechOutputDependencies } from "../src/browser/speech-output.ts";

function voice(voiceURI = "local-en", localService = true, lang = "en-US"): SpeechSynthesisVoice {
  return { voiceURI, name: voiceURI, lang, localService, default: false };
}

function fixture(initial: SpeechSynthesisVoice[] = [voice()]) {
  let inventory = initial;
  let cancelCount = 0;
  let throwOnSpeak = false;
  let throwOnCancel = false;
  let throwOnInventory = false;
  const statuses: string[] = [];
  const utterances: SpeechSynthesisUtterance[] = [];
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; milliseconds: number }>();
  const dependencies: LocalSpeechOutputDependencies = {
    synthesis: {
      getVoices: () => { if (throwOnInventory) throw new Error("inventory failed"); return inventory; },
      speak: utterance => {
        assert.ok(utterance.voice && utterance.voice.localService === true);
        assert.equal(utterance.lang, utterance.voice.lang);
        utterances.push(utterance);
        if (throwOnSpeak) throw new Error("playback failed");
      },
      cancel: () => { cancelCount++; if (throwOnCancel) throw new Error("cancel failed"); },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) listeners.add(listener); },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) listeners.delete(listener); },
    },
    createUtterance: text => ({ text, voice: null, lang: "", onend: null, onerror: null }) as SpeechSynthesisUtterance,
    setTimeout: (callback, milliseconds) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.set(handle, { callback, milliseconds });
      return handle;
    },
    clearTimeout: timer => { timers.delete(timer); },
  };
  const output = new LocalSpeechOutput(message => statuses.push(message), dependencies);
  return {
    output, dependencies, statuses, utterances, listeners, timers,
    get cancelCount() { return cancelCount; },
    setInventory(value: SpeechSynthesisVoice[]) { inventory = value; },
    failSpeak() { throwOnSpeak = true; },
    failCancel() { throwOnCancel = true; },
    failInventory() { throwOnInventory = true; },
    voicesChanged() {
      for (const listener of listeners) {
        if (typeof listener === "function") listener(new Event("voiceschanged"));
        else listener.handleEvent(new Event("voiceschanged"));
      }
    },
  };
}

function callbacks(utterance: SpeechSynthesisUtterance) {
  const end = utterance.onend;
  const error = utterance.onerror;
  return {
    end: () => end?.call(utterance, {} as SpeechSynthesisEvent),
    error: () => error?.call(utterance, {} as SpeechSynthesisErrorEvent),
  };
}

test("LocalSpeechOutput stays text-only for no voices, remote-only, non-English and empty URI voices", () => {
  for (const inventory of [[], [voice("remote", false)], [voice("fr", true, "fr-FR")], [voice("")]]) {
    const f = fixture(inventory);
    assert.deepEqual(f.output.voices(), []);
    f.output.select(inventory[0]?.voiceURI ?? "missing");
    f.output.speak("hello");
    assert.equal(f.utterances.length, 0);
    assert.match(f.statuses.at(-1)!, /Text only/);
    f.output.dispose();
  }
});

test("LocalSpeechOutput supports missing browser speech APIs without a fallback", () => {
  const statuses: string[] = [];
  const output = new LocalSpeechOutput(message => statuses.push(message), {
    setTimeout, clearTimeout,
  });
  output.select("local-en");
  output.speak("hello");
  assert.deepEqual(output.voices(), []);
  assert.match(statuses.at(-1)!, /Text only/);
  output.dispose();
});

test("LocalSpeechOutput enumerates only local English metadata and requires explicit selection", () => {
  const english = { ...voice(), default: true };
  const f = fixture([english, voice("remote", false), voice("french", true, "fr"), voice("british", true, "en-GB")]);
  assert.deepEqual(f.output.voices(), [
    { voiceURI: "local-en", name: "local-en", lang: "en-US" },
    { voiceURI: "british", name: "british", lang: "en-GB" },
  ]);
  f.output.speak("No implicit default");
  assert.equal(f.utterances.length, 0);
  f.output.select("local-en");
  f.output.speak("hello");
  assert.equal(f.utterances[0].voice, english);
  assert.equal(f.utterances[0].lang, "en-US");
  assert.equal(f.utterances[0].text, "hello");
  callbacks(f.utterances[0]).end();
  assert.equal(f.timers.size, 0);
  assert.equal(f.cancelCount, 0);
  assert.match(f.statuses.at(-1)!, /finished/);
  f.output.dispose();
});

test("LocalSpeechOutput supports delayed voiceschanged without auto-selecting or replaying text", () => {
  const f = fixture([]);
  f.output.speak("Do not replay");
  f.setInventory([voice()]);
  f.voicesChanged();
  assert.equal(f.output.voices().length, 1);
  assert.match(f.statuses.at(-1)!, /select a local English voice/);
  f.output.speak("Still not selected");
  assert.equal(f.utterances.length, 0);
  f.output.select("local-en");
  f.output.speak("Explicit new request");
  assert.equal(f.utterances.length, 1);
  f.output.dispose();
});

test("LocalSpeechOutput re-resolves the current voice object for every utterance", () => {
  const f = fixture();
  f.output.select("local-en");
  const replacement = voice("local-en", true, "en-GB");
  f.setInventory([replacement]);
  f.output.speak("hello");
  assert.equal(f.utterances[0].voice, replacement);
  assert.equal(f.utterances[0].lang, "en-GB");
  f.output.dispose();
});

test("LocalSpeechOutput rejects disappeared, changed-to-remote, changed-language and ambiguous selected voices", () => {
  for (const inventory of [[], [voice("local-en", false)], [voice("local-en", true, "fr")], [voice(), voice()]]) {
    const f = fixture();
    f.output.select("local-en");
    f.setInventory(inventory); // No voiceschanged event: speak must still recheck.
    f.output.speak("never use a default");
    assert.equal(f.utterances.length, 0);
    f.setInventory([voice()]);
    f.output.speak("selection was revoked");
    assert.equal(f.utterances.length, 0);
    f.output.dispose();
  }
});

test("LocalSpeechOutput cancels active speech when voiceschanged removes the selected voice", () => {
  const f = fixture();
  f.output.select("local-en");
  f.output.speak("hello");
  const late = callbacks(f.utterances[0]);
  f.setInventory([]);
  f.voicesChanged();
  assert.equal(f.cancelCount, 1);
  assert.equal(f.timers.size, 0);
  assert.match(f.statuses.at(-1)!, /no longer available/);
  const count = f.statuses.length;
  late.end(); late.error();
  assert.equal(f.statuses.length, count);
  f.output.dispose();
});

test("LocalSpeechOutput replaces rather than queues, fences canceled callbacks and clears timers", () => {
  const f = fixture();
  f.output.select("local-en");
  f.output.speak("first");
  const late = callbacks(f.utterances[0]);
  const lateTimeout = [...f.timers.values()][0].callback;
  f.output.speak("second");
  assert.equal(f.cancelCount, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.utterances[0].onend, null);
  const count = f.statuses.length;
  late.end(); late.error(); lateTimeout();
  assert.equal(f.statuses.length, count);
  assert.equal(f.timers.size, 1);
  const secondLate = callbacks(f.utterances[1]);
  f.output.cancel();
  assert.equal(f.cancelCount, 2);
  assert.equal(f.timers.size, 0);
  const canceledCount = f.statuses.length;
  secondLate.end(); secondLate.error();
  assert.equal(f.statuses.length, canceledCount);
  assert.equal(f.utterances.length, 2);
  f.output.dispose();
});

test("LocalSpeechOutput rejects empty/oversized text and bounds accepted utterances to 1000 characters", () => {
  const f = fixture();
  f.output.select("local-en");
  for (const text of ["", " \n\t", "x".repeat(1001)]) f.output.speak(text);
  assert.equal(f.utterances.length, 0);
  f.output.speak("x".repeat(1000));
  assert.equal(f.utterances.length, 1);
  f.output.speak("x".repeat(1001));
  assert.equal(f.utterances.length, 1);
  assert.equal(f.cancelCount, 1);
  assert.equal(f.timers.size, 0);
  f.output.dispose();
});

test("LocalSpeechOutput changing or clearing selection cancels speech and invalid selection stays silent", () => {
  const f = fixture();
  f.output.select("local-en");
  f.output.speak("hello");
  f.output.select("");
  assert.equal(f.cancelCount, 1);
  f.output.speak("not selected");
  f.output.select("missing");
  f.output.speak("missing");
  assert.equal(f.utterances.length, 1);
  f.output.dispose();
});

test("LocalSpeechOutput errors and 30-second timeout cancel and fence all subsequent callbacks", () => {
  for (const outcome of ["error", "timeout", "throw"] as const) {
    const f = fixture();
    f.output.select("local-en");
    if (outcome === "throw") f.failSpeak();
    f.output.speak("hello");
    const late = callbacks(f.utterances[0]);
    if (outcome === "error") late.error();
    if (outcome === "timeout") {
      const timer = [...f.timers.values()][0];
      assert.equal(timer.milliseconds, 30_000);
      timer.callback();
    }
    assert.equal(f.cancelCount, 1);
    assert.equal(f.timers.size, 0);
    assert.match(f.statuses.at(-1)!, /Text only: local speech (failed|timed out)/);
    const count = f.statuses.length;
    late.end(); late.error();
    assert.equal(f.statuses.length, count);
    assert.equal(f.utterances.length, 1);
    f.output.dispose();
  }
});

test("LocalSpeechOutput inventory failure is text-only and cancellation failure prevents queue growth", () => {
  const f = fixture();
  f.output.select("local-en");
  f.failInventory();
  f.output.speak("no inventory");
  assert.equal(f.utterances.length, 0);
  f.output.dispose();
  const g = fixture();
  g.output.select("local-en");
  g.output.speak("first");
  g.failCancel();
  g.output.speak("second");
  g.output.select("local-en");
  g.output.speak("third");
  assert.equal(g.utterances.length, 1);
  assert.equal(g.timers.size, 0);
  assert.match(g.statuses.at(-1)!, /cancellation failed/);
  g.output.dispose();
});

test("LocalSpeechOutput dispose removes listeners, cancels once and makes late calls inert", () => {
  const f = fixture();
  f.output.select("local-en");
  f.output.speak("hello");
  const late = callbacks(f.utterances[0]);
  const lateTimeout = [...f.timers.values()][0].callback;
  const lateListener = [...f.listeners][0] as EventListener;
  assert.equal(f.listeners.size, 1);
  f.output.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.cancelCount, 1);
  assert.equal(f.timers.size, 0);
  const count = f.statuses.length;
  late.end(); late.error(); lateTimeout(); lateListener(new Event("voiceschanged"));
  f.output.select("local-en"); f.output.speak("late"); f.output.cancel(); f.output.dispose();
  assert.deepEqual(f.output.voices(), []);
  assert.equal(f.statuses.length, count);
  assert.equal(f.cancelCount, 1);
  assert.equal(f.utterances.length, 1);
});
