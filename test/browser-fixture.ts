import { html, render } from "lit";
import { LocalRecognizer, type LocalRecognitionCallbacks, type LocalRecognitionDependencies } from "../src/browser/audio.ts";
import "../src/browser/index.ts";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { Worker } from "../src/protocol.ts";
import { pageSpeechCoordinator } from "../src/browser/speech-coordinator.js";
import type { TtsProgress } from "../src/browser/tts-contract.js";
import type { SpeechPreparation } from "../src/browser/speech-assets.js";

const stats = {
  stops: 0, captures: 0, preparations: 0, terminations: 0, transcriptions: 0, instructions: 0,
  acquisitions: [] as { source: string; bytes?: number }[],
  disarms: [] as string[], requests: [] as { workspaceId: string; operation: string; input: any }[],
  pendingPermission: false, pendingArm: false, pendingPrepare: false, pendingTranscript: false, pendingRead: false, pendingList: false, failList: false,
  failSpeechCancel: false, failExecute: false, spoken: [] as { text: string; voiceURI?: string }[], speechCancels: 0, navigations: [] as unknown[],
  ttsPreparations: 0, ttsRuntimes: 0, ttsTerminations: 0, ttsPlans: [] as string[], ttsChunks: 0,
  ttsAcquisitions: [] as { source: string; bytes?: number }[],
  audioContexts: 0, audioCloses: 0, audioDisconnects: 0, resumedInGesture: [] as boolean[],
  pendingTtsPrepare: false, pendingPlan: false, pendingChunk: false, pendingResume: false, pendingClose: false,
  failResume: false, failClose: false, failChunk: false, ttsChunkCount: 1, failChunkAt: -1,
};
let permissionResolve: (() => void) | undefined;
let armResolve: (() => void) | undefined;
let prepareResolve: (() => void) | undefined;
let transcriptResolve: ((value: string) => void) | undefined;
const readResolvers: Array<() => void> = [];
const listResolvers: Array<() => void> = [];
let progress: ((message: string) => void) | undefined;
let samples: ((pcm: Float32Array) => void) | undefined;
let resultText = "<img src=x onerror=alert('bad')> Escaped result";
const pcm = (length = 8000) => Float32Array.from({ length }, (_, i) => Math.sin(i / 8) * 0.15);
const media = { getUserMedia: async () => { throw new Error("Fixture capture must use the injected PCM seam"); } };
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
const dependencies: LocalRecognitionDependencies = {
  coordinator: pageSpeechCoordinator(),
  createRuntime: () => ({
    async prepare(status, options = { source: "cache" }) {
      stats.acquisitions.push({ source: options.source, ...(options.source === "import" ? { bytes: options.file.size } : {}) });
      stats.preparations++; progress = status; status("Loading local pack · fixture 50%");
      if (stats.pendingPrepare) await new Promise<void>(resolve => { prepareResolve = resolve; });
    },
    async transcribe() {
      stats.transcriptions++;
      if (stats.pendingTranscript) return new Promise<string>(resolve => { transcriptResolve = resolve; });
      return "Dictated instruction, never automatic approval";
    },
    terminate() { stats.terminations++; },
  }),
  async openCapture(_signal, onSamples) {
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Local microphone capture requires HTTPS or device-local localhost");
    stats.captures++; samples = onSamples;
    let stopped = false;
    const capture = { stop() { if (!stopped) { stopped = true; stats.stops++; } } };
    if (stats.pendingPermission) await new Promise<void>(resolve => { permissionResolve = resolve; });
    // Intentionally non-cooperative: the real recognizer must fence and stop late captures/results.
    onSamples(pcm());
    return capture;
  },
};
// The browser test bundler replaces only the panel's recognizer import with this
// constructor. Production has no fixture global, factory hook or network bypass.
class FixtureRecognizer {
  constructor(callbacks: LocalRecognitionCallbacks) { return LocalRecognizer.createForTest(callbacks, dependencies); }
}
export { FixtureRecognizer as LocalRecognizer };
// Accessing either OS speech API is a test failure, including during panel mounting.
for (const key of ["speechSynthesis", "SpeechSynthesisUtterance"]) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error("OS speech API forbidden"); } });
let ttsPrepareResolve: (() => void) | undefined, planResolve: (() => void) | undefined, chunkResolve: (() => void) | undefined;
let resumeResolve: (() => void) | undefined, closeResolve: (() => void) | undefined;
let lateSpeechEnd: (() => void) | undefined, endSpeech: (() => void) | undefined;
let currentTtsText = "";
class FixtureTtsRuntime {
  constructor() { stats.ttsRuntimes++; }
  async prepare(status: (progress: TtsProgress) => void, options: SpeechPreparation = { source: "cache" }) {
    stats.ttsPreparations++;
    stats.ttsAcquisitions.push({ source: options.source, ...(options.source === "import" ? { bytes: options.file.size } : {}) });
    status({ phase: "checking", checkedBytes: 5, totalBytes: 10 });
    if (stats.pendingTtsPrepare) await new Promise<void>(resolve => { ttsPrepareResolve = resolve; });
    status({ phase: "initializing" });
  }
  async plan(text: string) {
    stats.ttsPlans.push(text); currentTtsText = text;
    if (stats.pendingPlan) await new Promise<void>(resolve => { planResolve = resolve; });
    return stats.ttsChunkCount;
  }
  async chunk(index: number) {
    stats.ttsChunks++;
    if (stats.pendingChunk) await new Promise<void>(resolve => { chunkResolve = resolve; });
    if (stats.failChunk || index === stats.failChunkAt) throw new Error("Fixture synthesis failure");
    return new Float32Array(2400).fill(0.1);
  }
  terminate() { stats.ttsTerminations++; }
}
export { FixtureTtsRuntime as WorkerTtsRuntime };
class FixtureAudioContext {
  state: AudioContextState = "suspended";
  destination = {};
  onstatechange: (() => void) | null = null;
  constructor() { stats.audioContexts++; }
  async resume() {
    stats.resumedInGesture.push(navigator.userActivation.isActive);
    if (stats.pendingResume) await new Promise<void>(resolve => { resumeResolve = resolve; });
    if (stats.failResume) throw new Error("Fixture resume rejected");
    if (this.state !== "closed") this.state = "running";
  }
  async close() {
    stats.audioCloses++;
    if (stats.pendingClose) await new Promise<void>(resolve => { closeResolve = resolve; });
    if (stats.failClose) throw new Error("Fixture close rejected");
    this.state = "closed";
  }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() { stats.audioDisconnects++; } }; }
  createBuffer(channels: number, length: number, rate: number) {
    if (channels !== 1 || rate !== 24000 || length > 720000) throw new Error("Invalid playback buffer");
    return { copyToChannel(data: Float32Array, channel: number) { if (data.length !== length || channel !== 0) throw new Error("Invalid PCM copy"); } };
  }
  createBufferSource() {
    const source = { buffer: null as unknown, onended: null as (() => void) | null, connect() {},
      disconnect() { stats.audioDisconnects++; },
      start() {
        const callback = source.onended;
        lateSpeechEnd = () => callback?.();
        endSpeech = () => source.onended?.();
        stats.spoken.push({ text: currentTtsText, voiceURI: "af_heart" });
      },
      stop() { stats.speechCancels++; if (stats.failSpeechCancel) throw new Error("Fixture source stop failed"); },
    };
    return source;
  }
}
Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FixtureAudioContext });
const workspaceWorkers = new Map<string, Worker[]>();
let context: WorkspacePanelContext;
function makeContext(workspaceId: string, sessionId = "catalog-session") {
  const workers = workspaceWorkers.get(workspaceId) ?? [];
  workspaceWorkers.set(workspaceId, workers);
  return {
    machine: { id: "local", name: "Test machine", kind: "local" },
    workspace: { id: workspaceId, projectId: "project", path: "/test", label: workspaceId, isMain: true },
    state: { selectedProject: { id: "project", name: "Test project", path: "/test" }, selectedSession: { id: sessionId } },
    peer: { async request(operation: string, input: any) {
      stats.requests.push({ workspaceId, operation, input });
      switch (operation) {
        case "list": {
          if (stats.failList) throw new Error("Fixture status unavailable");
          const snapshot = structuredClone(workers.map(w => ({ ...w, text: "", ...(w.question ? { question: "Input requested; read worker for details." } : {}) })));
          if (stats.pendingList) await new Promise<void>(resolve => { listResolvers.push(resolve); });
          return snapshot;
        }
        case "arm": {
          const token = `fixture-token-${stats.requests.filter(r => r.operation === "arm").length}`;
          if (stats.pendingArm) await new Promise<void>(resolve => { armResolve = resolve; });
          return { token, remaining: input.count, expiresAt: Date.now() + 600000 };
        }
        case "disarm": stats.disarms.push(workspaceId); return { ok: true };
        case "execute": {
          stats.instructions++;
          if (stats.failExecute) throw new Error("Uncertain fixture delivery");
          const c = input.command;
          if (c.kind === "reply") {
            const w = workers.find(w => w.id === c.workerId);
            if (!w || w.revision !== c.expectedRevision) throw new Error("Stale fixture revision");
            if (!["needs-input", "completed", "failed"].includes(w.status)) throw new Error("Worker is busy or its state is unknown; inspect session first");
            w.revision++; w.status = "running"; return structuredClone(w);
          }
          const w: Worker = { id: c.requestId, projectId: "project", workspaceId, sessionId: "exact-session", title: c.title, status: "running", model: c.model ?? "default", text: "", revision: 1, createdAt: "", updatedAt: "" };
          workers.push(w); return structuredClone(w);
        }
        case "read": {
          const result = { ...workers.find(w => w.id === input.workerId), text: resultText };
          if (stats.pendingRead) await new Promise<void>(resolve => { readResolvers.push(resolve); });
          return result;
        }
        case "models": return [{ id: "test/model", name: "Test model" }];
        default: throw new Error(`Unknown fixture request: ${operation}`);
      }
    } },
    navigate: async (target: unknown) => { stats.navigations.push(target); }, host: { requestRender() {} },
  } as unknown as WorkspacePanelContext;
}
function mount(workspaceId = "workspace-a", sessionId?: string) {
  context = makeContext(workspaceId, sessionId);
  render(html`<compn3rd-voice-panel .context=${context}></compn3rd-voice-panel>`, document.body);
}
mount();
(globalThis as any).fixture = {
  stats, mount,
  request(operation: string, input: any = {}) { return context.peer!.request!(operation, input); },
  setWorkerStatus(status: Worker["status"]) {
    const worker = workspaceWorkers.get(context.workspace.id)![0];
    worker.status = status; worker.revision++;
  },
  resolvePermission() { stats.pendingPermission = false; permissionResolve?.(); },
  resolveArm() { stats.pendingArm = false; armResolve?.(); },
  resolvePrepare() { stats.pendingPrepare = false; progress?.("Late pack progress"); prepareResolve?.(); },
  resolveTranscript(value = "Late canceled transcript") { stats.pendingTranscript = false; transcriptResolve?.(value); },
  resolveRead(index = 0) { stats.pendingRead = false; readResolvers.splice(index, 1)[0]?.(); },
  resolveList() { stats.pendingList = false; listResolvers.shift()?.(); },
  reachLimit() { samples?.(pcm(320000)); },
  pause() { samples?.(new Float32Array(19200)); },
  seedWorkers(values: Partial<Worker>[]) {
    const workers = workspaceWorkers.get(context.workspace.id)!;
    workers.splice(0, workers.length, ...values.map((value, index) => ({
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, projectId: "project", workspaceId: context.workspace.id,
      sessionId: `session-${index + 1}`, title: "Same title", model: "test/model", status: "needs-input" as const,
      text: "", revision: 1, createdAt: "", updatedAt: "", ...value,
    })));
  },
  setResult(value: string) { resultText = value; },
  bumpRevision() { workspaceWorkers.get(context.workspace.id)![0].revision++; },
  endSpeech() { endSpeech?.(); },
  lateSpeechEnd() { lateSpeechEnd?.(); },
  resolveTtsPrepare() { stats.pendingTtsPrepare = false; ttsPrepareResolve?.(); },
  resolvePlan() { stats.pendingPlan = false; planResolve?.(); },
  resolveChunk() { stats.pendingChunk = false; chunkResolve?.(); },
  resolveResume() { stats.pendingResume = false; resumeResolve?.(); },
  resolveClose() { stats.pendingClose = false; closeResolve?.(); },
  setMediaSupported(supported: boolean) { Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: supported ? media : undefined }); },
  setSecureContext(secure: boolean) { Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: secure }); },
  setHidden(hidden: boolean) { Object.defineProperty(document, "hidden", { configurable: true, value: hidden }); document.dispatchEvent(new Event("visibilitychange")); },
  unmount() { render(html``, document.body); },
};
