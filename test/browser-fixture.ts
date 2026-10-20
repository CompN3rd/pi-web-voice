import { html, render } from "lit";
import "../src/browser/index.ts";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

const stats = { stops: 0, connections: 0, instructions: 0, disarms: [] as string[], sent: [] as any[], requests: [] as any[], pendingPermission: false, pendingArm: false, attachedTracks: [] as any[] };
let permissionResolve: ((value: any) => void) | undefined;
let lastChannel: any;
let armResolve: (() => void) | undefined;
const stream = () => {
  const track = { stopped: false, enabled: true, stop() { if (!this.stopped) { this.stopped = true; stats.stops++; } }, addEventListener() {} };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
};
const media = { getUserMedia: async () => stats.pendingPermission ? new Promise(resolve => { permissionResolve = resolve; }) : stream() };
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
HTMLMediaElement.prototype.play = async () => {};
HTMLMediaElement.prototype.pause = () => {};
class FakePeer {
  connectionState = "new";
  onconnectionstatechange?: () => void;
  ontrack?: (event: unknown) => void;
  addTrack(track: any) { stats.attachedTracks.push(track); }
  createDataChannel() {
    lastChannel = { readyState: "connecting", onmessage: undefined, onopen: undefined, onclose: undefined as (() => void) | undefined, send(data: string) { stats.sent.push(JSON.parse(data)); }, close() { this.readyState = "closed"; this.onclose?.(); } };
    return lastChannel;
  }
  async createOffer() { return { type: "offer", sdp: "v=0\r\nfixture-offer\r\n" }; }
  async setLocalDescription() {}
  async setRemoteDescription(answer: { sdp: string }) {
    if (!answer.sdp.endsWith("\r\n")) throw new Error("SDP terminator was trimmed");
    stats.connections++; lastChannel.readyState = "open"; lastChannel.onopen?.();
  }
  close() { this.connectionState = "closed"; }
}
Object.defineProperty(globalThis, "RTCPeerConnection", { value: FakePeer });
let workers: any[] = [];
let context: WorkspacePanelContext;
function makeContext(workspaceId: string) {
  return {
    machine: { id: "local", name: "Test machine", kind: "local" },
    workspace: { id: workspaceId, projectId: "project", path: "/test", label: workspaceId, isMain: true },
    state: { selectedProject: { id: "project", name: "Test project", path: "/test" }, selectedSession: { id: "catalog-session" } },
    peer: { async request(operation: string, input: any) {
      stats.requests.push({ workspaceId, operation, input });
      switch (operation) {
        case "list": return structuredClone(workers);
        case "connect": return { sdp: "v=0\r\nfixture-answer\r\n" };
        case "arm": {
          if (stats.pendingArm) await new Promise<void>(resolve => { armResolve = resolve; });
          return { token: "fixture-token", remaining: input.count, expiresAt: Date.now() + 600000 };
        }
        case "disarm": stats.disarms.push(workspaceId); return { ok: true };
        case "execute": {
          stats.instructions++;
          const c = input.command;
          const w = { id: c.requestId, projectId: "project", workspaceId, sessionId: "exact-session", title: c.title, status: "running", model: c.model ?? "default", text: "", revision: 1, createdAt: "", updatedAt: "" };
          workers.push(w); return w;
        }
        case "read": return { ...workers.find(w => w.id === input.workerId), text: "<img src=x onerror=alert('bad')> Escaped result", status: "completed" };
        case "models": return [{ id: "test/model", name: "Test model" }];
        default: throw new Error("Unknown fixture request");
      }
    } },
    navigate: async () => {}, host: { requestRender() {} },
  } as unknown as WorkspacePanelContext;
}
function mount(workspaceId = "workspace-a") {
  context = makeContext(workspaceId);
  render(html`<compn3rd-voice-panel .context=${context}></compn3rd-voice-panel>`, document.body);
}
mount();
(globalThis as any).fixture = {
  stats, mount,
  event(event: any) { lastChannel.onmessage?.({ data: JSON.stringify(event) }); },
  resolvePermission() { permissionResolve?.(stream()); },
  resolveArm() { stats.pendingArm = false; armResolve?.(); },
  setMediaSupported(supported: boolean) { Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: supported ? media : undefined }); },
  setSecureContext(secure: boolean) { Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: secure }); },
  setHidden(hidden: boolean) { Object.defineProperty(document, "hidden", { configurable: true, value: hidden }); document.dispatchEvent(new Event("visibilitychange")); },
  unmount() { render(html``, document.body); },
};
