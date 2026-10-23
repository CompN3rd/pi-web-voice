import assert from "node:assert/strict";
import test from "node:test";
import { pageSpeechCoordinator, SpeechCoordinator, type SpeechOwner } from "../src/browser/speech-coordinator.ts";
import { ModelSpeechOutput } from "../src/browser/speech-output.ts";
import { LocalRecognizer } from "../src/browser/audio.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function owner(kind: SpeechOwner["kind"] = "tts", phase: SpeechOwner["phase"] = "idle"): SpeechOwner {
  return { kind, phase, release: () => true };
}

test("SpeechCoordinator observers see settled and canceled handoffs without reentrant acquisition", async () => {
  for (const canceled of [false, true]) {
    const coordinator = new SpeechCoordinator(), previous = owner(), next = owner("recognition"), done = deferred<boolean>();
    previous.release = () => { coordinator.release(previous); return done.promise; };
    coordinator.acquire(previous);
    const states: boolean[] = [], blocked: boolean[] = [];
    coordinator.subscribe(() => { throw new Error("Observer failure"); });
    const unsubscribe = coordinator.subscribe(() => {
      states.push(coordinator.stopping);
      if (coordinator.stopping) { try { coordinator.acquire(owner()); blocked.push(false); } catch (error) { blocked.push(error instanceof Error && /busy/.test(error.message)); } }
    });
    const handoff = coordinator.acquire(next)!;
    const result = canceled ? assert.rejects(handoff, { name: "AbortError" }) : handoff;
    if (canceled) coordinator.release(next);
    done.resolve(true); await result;
    assert.equal(states[0], true); assert.equal(states.at(-1), false);
    assert.ok(blocked.length > 0 && blocked.every(Boolean));
    assert.equal(coordinator.owns(next), !canceled);
    unsubscribe(); const count = states.length;
    coordinator.release(next); coordinator.latchUnsafe();
    assert.equal(states.length, count);
  }
});

test("SpeechCoordinator notifies cache completion/failure and irreversible unsafe state", async () => {
  for (const fail of [false, true]) {
    const coordinator = new SpeechCoordinator(), done = deferred<void>();
    const states: { stopping: boolean; safe: boolean }[] = [];
    coordinator.subscribe(() => states.push({ stopping: coordinator.stopping, safe: coordinator.safe }));
    const clear = coordinator.clearPack("tts", async () => { await done.promise; if (fail) throw new Error("Storage failure"); });
    const result = fail ? assert.rejects(clear, /Storage failure/) : clear;
    assert.equal(coordinator.stopping, true);
    done.resolve(); await result;
    assert.deepEqual(states.at(-1), { stopping: false, safe: true });
    coordinator.latchUnsafe();
    assert.deepEqual(states.at(-1), { stopping: false, safe: false });
    assert.throws(() => coordinator.acquire(owner()), /unsafe/);
  }
});

test("SpeechCoordinator acquires an empty document synchronously and only releases the exact owner", () => {
  const coordinator = new SpeechCoordinator(), first = owner(), other = owner();
  assert.equal(coordinator.acquire(first), undefined);
  assert.equal(coordinator.owns(first), true);
  coordinator.release(other); assert.equal(coordinator.owns(first), true);
  assert.equal(coordinator.acquire(first), undefined);
  coordinator.release(first); assert.equal(coordinator.owns(first), false);
});

test("SpeechCoordinator rejects active recognition and all preparing/stopping runtime owners", () => {
  for (const kind of ["recognition", "tts"] as const) {
    for (const phase of ["preparing", "stopping", "active"] as const) {
      const coordinator = new SpeechCoordinator(), first = owner(kind, phase);
      coordinator.acquire(first);
      if (kind === "tts" && phase === "active") {
        assert.throws(() => coordinator.acquire(owner("tts")), /busy/);
      } else {
        assert.throws(() => coordinator.acquire(owner("recognition")), /busy/);
        assert.throws(() => coordinator.acquire(owner("tts")), /busy/);
      }
      assert.equal(coordinator.owns(first), true);
    }
  }
});

test("SpeechCoordinator reserves handoff before reentrant releases and blocks third-party acquisition", async () => {
  const coordinator = new SpeechCoordinator(), teardown = deferred<boolean>();
  const next = owner("recognition"), intruder = owner();
  const previous = owner("tts", "active");
  previous.release = () => {
    coordinator.release(previous);
    assert.throws(() => coordinator.acquire(intruder), /busy/);
    assert.equal(coordinator.stopping, true);
    return teardown.promise;
  };
  coordinator.acquire(previous);
  const acquired = coordinator.acquire(next);
  assert.equal(coordinator.owns(next), false);
  assert.throws(() => coordinator.acquire(intruder), /busy/);
  teardown.resolve(true); await acquired;
  assert.equal(coordinator.owns(next), true);
  coordinator.release(previous); assert.equal(coordinator.owns(next), true);
});

test("SpeechCoordinator canceled incoming acquisition never revives on late release", async () => {
  const coordinator = new SpeechCoordinator(), teardown = deferred<boolean>();
  const previous = owner(), next = owner("recognition"), third = owner();
  previous.release = () => teardown.promise;
  coordinator.acquire(previous);
  const acquired = coordinator.acquire(next)!;
  const rejected = assert.rejects(acquired, { name: "AbortError" });
  coordinator.release(next);
  assert.throws(() => coordinator.acquire(third), /busy/);
  teardown.resolve(true); await rejected;
  assert.equal(coordinator.owns(next), false); assert.equal(coordinator.stopping, false);
  coordinator.acquire(third); assert.equal(coordinator.owns(third), true);
});

test("SpeechCoordinator synchronous throw and failed release irreversibly latch unsafe", async () => {
  for (const failure of ["throw", "reject", "false"]) {
    const coordinator = new SpeechCoordinator(), previous = owner();
    previous.release = () => {
      if (failure === "throw") throw new Error("release");
      return failure === "reject" ? Promise.reject(new Error("release")) : false;
    };
    coordinator.acquire(previous);
    await assert.rejects(coordinator.acquire(owner())!, /unsafe/);
    coordinator.release(previous);
    assert.equal(coordinator.safe, false);
    assert.throws(() => coordinator.acquire(owner()), /unsafe/);
  }
});

test("SpeechCoordinator unsafe state survives controller remount and blocks default recognition without construction", async () => {
  const coordinator = pageSpeechCoordinator();
  assert.equal(pageSpeechCoordinator(), coordinator);
  coordinator.latchUnsafe();
  const runtime = () => { assert.fail("unsafe controller constructed runtime"); };
  const output = new ModelSpeechOutput(() => {}, runtime);
  assert.equal(output.cancellationSafe, false);
  output.setEnabled(true); assert.equal(output.enabled, false);
  await assert.rejects(output.prepare(), /unsafe/);
  assert.equal(await output.dispose(), false);
  const remounted = new ModelSpeechOutput(() => {}, runtime);
  assert.equal(remounted.cancellationSafe, false);
  const recognizer = new LocalRecognizer({ status() {}, transcript() {} });
  await assert.rejects(recognizer.prepare(), /unsafe/);
  await assert.rejects(recognizer.start(), /Prepare/);
  recognizer.dispose();
  assert.equal(pageSpeechCoordinator().safe, false);
  // Isolated test coordinators are explicit, never the production remount default.
  assert.equal(new SpeechCoordinator().safe, true);
});

test("SpeechCoordinator clearPack stops only the selected owner and reserves cache deletion", async () => {
  const coordinator = new SpeechCoordinator(), resident = owner("recognition", "active");
  let releases = 0, deletes = 0;
  resident.release = () => { releases++; return true; };
  coordinator.acquire(resident);
  await coordinator.clearPack("tts", async () => { deletes++; });
  assert.equal(releases, 0); assert.equal(coordinator.owns(resident), true);
  const deletion = deferred<void>();
  const clearing = coordinator.clearPack("recognition", async () => { deletes++; await deletion.promise; });
  await Promise.resolve();
  assert.equal(releases, 1); assert.equal(deletes, 2);
  assert.throws(() => coordinator.acquire(owner()), /busy/);
  await assert.rejects(coordinator.clearPack("tts", async () => {}), /busy/);
  deletion.resolve(); await clearing;
  assert.equal(coordinator.owns(resident), false);
  coordinator.acquire(owner());
});

test("SpeechCoordinator clearPack waits for teardown, rejects unsafe release, preserves latch on deletion", async () => {
  const coordinator = new SpeechCoordinator(), resident = owner(), teardown = deferred<boolean>();
  let deleted = false;
  resident.release = () => teardown.promise;
  coordinator.acquire(resident);
  const clearing = coordinator.clearPack("tts", async () => { deleted = true; });
  const rejected = assert.rejects(clearing, /unsafe/);
  assert.equal(deleted, false); teardown.resolve(false); await rejected;
  assert.equal(coordinator.safe, false); assert.equal(deleted, false);
  coordinator.release(resident);
  await coordinator.clearPack("tts", async () => { deleted = true; });
  assert.equal(deleted, true); assert.equal(coordinator.safe, false);
});

test("SpeechCoordinator clearPack cannot compete with other-pack preparation; deletion failure releases reservation", async () => {
  const coordinator = new SpeechCoordinator(), preparing = owner("recognition", "preparing");
  coordinator.acquire(preparing);
  await assert.rejects(coordinator.clearPack("tts", async () => assert.fail()), /busy/);
  coordinator.release(preparing);
  await assert.rejects(coordinator.clearPack("tts", async () => { throw new Error("cache failure"); }), /cache failure/);
  assert.equal(coordinator.safe, true); assert.equal(coordinator.stopping, false);
  coordinator.acquire(owner());
});

test("SpeechCoordinator clearPack cancels selected TTS preparation before cache deletion", async () => {
  const coordinator = new SpeechCoordinator(), loading = deferred<void>();
  let terminated = 0, deleted = false;
  const output = new ModelSpeechOutput(() => {}, () => ({
    prepare: () => loading.promise, plan: async () => 1, chunk: async () => new Float32Array(240),
    terminate() { terminated++; },
  }), { coordinator });
  const preparing = output.prepare();
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  await coordinator.clearPack("tts", async () => {
    assert.equal(terminated, 1); assert.equal(output.ready, false); deleted = true;
    await assert.rejects(output.prepare(), /busy/);
  });
  await rejected; loading.resolve(); await Promise.resolve();
  assert.equal(deleted, true); assert.equal(output.ready, false); assert.equal(coordinator.safe, true);
});

test("SpeechCoordinator clearPack awaits active recognition graph teardown under its reservation", async () => {
  const coordinator = new SpeechCoordinator(), closing = deferred<void>();
  let stopped = 0, terminated = 0, deleted = false, evicted = 0;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {}, unprepared() { evicted++; } }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate() { terminated++; } }),
    openCapture: async () => ({ stop() { stopped++; return closing.promise; } }),
  });
  await recognizer.prepare(); await recognizer.start();
  const clearing = coordinator.clearPack("recognition", async () => { deleted = true; });
  assert.equal(stopped, 1); assert.equal(terminated, 1); assert.equal(evicted, 1);
  assert.equal(deleted, false); assert.equal(recognizer.ready, false);
  assert.throws(() => coordinator.acquire(owner()), /busy/);
  closing.resolve(); await clearing;
  assert.equal(deleted, true); assert.equal(coordinator.safe, true);
  coordinator.acquire(owner());
});
