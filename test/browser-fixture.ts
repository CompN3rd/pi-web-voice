import { html, render } from "lit";
import { LocalRecognizer, type LocalRecognitionCallbacks, type LocalRecognitionDependencies } from "../src/browser/audio.ts";
import "../src/browser/index.ts";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { Worker } from "../src/protocol.ts";

const stats = {
  stops: 0, captures: 0, preparations: 0, terminations: 0, transcriptions: 0, instructions: 0,
  disarms: [] as string[], requests: [] as { workspaceId: string; operation: string; input: any }[],
  pendingPermission: false, pendingArm: false, pendingPrepare: false, pendingTranscript: false, pendingRead: false,
  failSpeechCancel: false, failExecute: false, spoken: [] as { text: string; voiceURI?: string }[], speechCancels: 0, navigations: [] as unknown[],
};
let permissionResolve: (() => void) | undefined;
let armResolve: (() => void) | undefined;
let prepareResolve: (() => void) | undefined;
let transcriptResolve: ((value: string) => void) | undefined;
let readResolve: (() => void) | undefined;
let progress: ((message: string) => void) | undefined;
let samples: ((pcm: Float32Array) => void) | undefined;
let resultText = "<img src=x onerror=alert('bad')> Escaped result";
const pcm = (length = 8000) => Float32Array.from({ length }, (_, i) => Math.sin(i / 8) * 0.15);
const media = { getUserMedia: async () => { throw new Error("Fixture capture must use the injected PCM seam"); } };
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
const dependencies: LocalRecognitionDependencies = {
  createRuntime: () => ({
    async prepare(status) {
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
const voice = (voiceURI: string, localService: boolean, lang = "en-US") => ({ voiceURI, name: voiceURI, localService, lang, default: false }) as SpeechSynthesisVoice;
let voices = [voice("Local English", true), voice("Remote English", false), voice("Local French", true, "fr-FR")];
const voiceEvents = new EventTarget();
let lateSpeechEnd: (() => void) | undefined;
Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, value: {
  getVoices: () => voices,
  speak(utterance: SpeechSynthesisUtterance) { const onend = utterance.onend; lateSpeechEnd = () => onend?.call(utterance, {} as SpeechSynthesisEvent); stats.spoken.push({ text: utterance.text, voiceURI: utterance.voice?.voiceURI }); },
  cancel() { stats.speechCancels++; if (stats.failSpeechCancel) throw new Error("Fixture speech cancellation failed"); },
  addEventListener: voiceEvents.addEventListener.bind(voiceEvents),
  removeEventListener: voiceEvents.removeEventListener.bind(voiceEvents),
} });
Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { configurable: true, value: class { voice = null; lang = ""; onend = null; onerror = null; constructor(public text: string) {} } });
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
        case "list": return structuredClone(workers);
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
          if (stats.pendingRead) await new Promise<void>(resolve => { readResolve = resolve; });
          return { ...workers.find(w => w.id === input.workerId), text: resultText };
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
  resolveRead() { stats.pendingRead = false; readResolve?.(); },
  reachLimit() { samples?.(pcm(320000)); },
  setResult(value: string) { resultText = value; },
  bumpRevision() { workspaceWorkers.get(context.workspace.id)![0].revision++; },
  removeLocalVoices() { voices = [voice("Remote English", false)]; voiceEvents.dispatchEvent(new Event("voiceschanged")); },
  lateSpeechEnd() { lateSpeechEnd?.(); },
  setMediaSupported(supported: boolean) { Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: supported ? media : undefined }); },
  setSecureContext(secure: boolean) { Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: secure }); },
  setHidden(hidden: boolean) { Object.defineProperty(document, "hidden", { configurable: true, value: hidden }); document.dispatchEvent(new Event("visibilitychange")); },
  unmount() { render(html``, document.body); },
};
