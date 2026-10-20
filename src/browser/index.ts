import { LitElement, html, css } from "lit";
import type { PiWebPlugin, WorkspacePanelContext, JsonValue } from "@jmfederico/pi-web/plugin-api";
import { record, text, uuid, MAX_MODEL, type Command, type Lease, type Worker, type ModelOption } from "../protocol.ts";
import { AudioConnection } from "./audio.ts";

const scope = (c?: WorkspacePanelContext) => c ? JSON.stringify([c.machine.id, c.workspace.projectId, c.workspace.id]) : "";
export class VoicePanel extends LitElement {
  static properties = { context: { attribute: false }, status: { state: true }, workers: { state: true }, drafts: { state: true }, caption: { state: true }, connected: { state: true }, muted: { state: true }, lease: { state: true }, models: { state: true }, detail: { state: true }, error: { state: true } };
  context?: WorkspacePanelContext;
  private status = "Disconnected · microphone off";
  private workers: Worker[] = [];
  private drafts: Command[] = [];
  private caption = "";
  private connected = false;
  private muted = false;
  private lease?: Lease;
  private models: ModelOption[] = [];
  private detail?: Worker;
  private error = "";
  private voice?: AudioConnection;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private permissionEpoch = 0;
  private lastScope = "";
  private activeContext?: WorkspacePanelContext;
  private refreshing = false;
  private seen = new Map<string, string>();
  private wakeLock?: WakeLockSentinel;
  private hide = () => { if (document.hidden) { this.shutdown(); this.status = "Page hidden · voice disconnected for privacy. Workers continue."; } };
  static styles = css`
    :host { display:block; color:var(--pi-fg,inherit); padding:16px; max-width:960px; margin:auto; font:inherit }
    h2,h3 { margin:.5em 0 } p { line-height:1.45 } .muted { opacity:.75 } .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 }
    button,select,input,textarea { font:inherit; color:inherit; background:var(--pi-bg,transparent); border:1px solid var(--pi-border,#888); border-radius:6px; padding:10px; min-height:44px; box-sizing:border-box }
    button { cursor:pointer } button:disabled { opacity:.5; cursor:default } button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--pi-accent,#5b9aff); outline-offset:2px }
    .primary { border:2px solid var(--pi-accent,#5b9aff) } .danger { border-color:#c66 } section,article { border:1px solid var(--pi-border,#888); border-radius:8px; padding:12px; margin:12px 0 }
    label { display:block; margin:8px 0 } input,textarea,select { width:100% } textarea { min-height:90px } pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:24em; overflow:auto }
    .error { color:var(--pi-error,#e77) } audio { width:100%; max-width:400px } .id { overflow-wrap:anywhere; font-size:.85em } .state { font-weight:600 } .caption { border-left:3px solid #888; padding-left:10px }
  `;
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.hide);
    this.timer = setInterval(() => { void this.refresh().catch(e => this.showError(e)); }, 5000);
  }
  disconnectedCallback() { this.shutdown(); clearInterval(this.timer); document.removeEventListener("visibilitychange", this.hide); super.disconnectedCallback(); }
  protected updated() {
    const key = scope(this.context);
    if (key !== this.lastScope) {
      this.shutdown(); this.activeContext = this.context; this.lastScope = key; this.workers = []; this.drafts = []; this.models = []; this.detail = undefined; this.caption = ""; this.seen.clear(); this.error = "";
      void this.refresh().catch(e => this.showError(e));
    }
  }
  private showError(error: unknown) { this.error = error instanceof Error ? error.message : String(error); }
  private async request(operation: string, input: unknown = {}, signal?: AbortSignal) {
    const context = this.context; const generation = this.generation;
    if (!context?.peer?.request) throw new Error("Paired Voice backend unavailable. Build/install the package and activate it during a safe daemon restart.");
    const result = await context.peer.request(operation, input as JsonValue, { signal });
    if (generation !== this.generation || scope(context) !== scope(this.context) || !this.isConnected) throw new Error("Selection changed; stale result discarded. Accepted work may continue.");
    return result;
  }
  private async refresh() {
    if (!this.context || !this.isConnected || this.refreshing) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const value = await this.request("list");
      if (!Array.isArray(value)) throw new Error("Invalid worker list");
      this.workers = value as unknown as Worker[];
      for (const worker of this.workers) {
        const previous = this.seen.get(worker.id);
        if (previous && previous !== worker.status && ["completed", "needs-input", "failed", "unknown"].includes(worker.status)) {
          this.voice?.notify(`Worker ${worker.id} is ${worker.status}. ${worker.status === "needs-input" ? "Ask to read its question." : "Ask to read its result for details."}`);
        }
        this.seen.set(worker.id, worker.status);
      }
      if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = undefined;
    } finally { if (generation === this.generation) this.refreshing = false; }
  }
  private async connectVoice() {
    if (this.voice) return;
    this.error = "";
    const generation = this.generation;
    const audio = this.renderRoot.querySelector("audio")!;
    const voice = new AudioConnection(audio, {
      status: message => { if (generation === this.generation) this.status = message; },
      caption: message => { if (generation === this.generation) this.caption = message; },
      tool: async (name, input, callId) => {
        if (generation !== this.generation) throw new Error("Voice scope expired");
        return this.handleTool(name, input, callId);
      },
      disconnected: () => {
        if (this.voice !== voice) return;
        this.voice = undefined; this.connected = false; this.muted = false;
        this.revoke(); void this.wakeLock?.release(); this.wakeLock = undefined;
      },
    });
    this.voice = voice; this.connected = true;
    try {
      await voice.start(async (sdp, signal) => {
        const answer = record(await this.request("connect", { sdp }, signal)).sdp;
        text(answer, "SDP", 48_000);
        return answer as string; // SDP is protocol text, not a trimmed user input.
      });
      if (this.voice !== voice) return;
      if (navigator.wakeLock) { try { const lock = await navigator.wakeLock.request("screen"); if (this.voice === voice) this.wakeLock = lock; else await lock.release(); } catch { /* optional, never a background guarantee */ } }
    } catch (error) { if (generation === this.generation) { this.showError(error); this.status = "Disconnected · microphone off"; } }
  }
  private revoke() {
    this.permissionEpoch++;
    this.lease = undefined;
    // Capture the old peer; selection changes must revoke the old scope, not the new one.
    void this.activeContext?.peer?.request?.("disarm", {}).catch(() => {});
  }
  private shutdown() {
    this.revoke(); this.generation++; this.refreshing = false;
    const voice = this.voice; this.voice = undefined; voice?.close();
    void this.wakeLock?.release(); this.wakeLock = undefined;
    this.connected = false; this.muted = false; this.status = "Disconnected · microphone off";
  }
  private async arm() {
    if (!confirm("Allow up to THREE text instructions (new workers or follow-ups) over the next 10 minutes in this workspace? Workers have ordinary Pi tool permissions and may edit files or run commands. Voice, other speakers, and model mistakes may trigger them. Enable only while parked and with a trusted audio environment.")) return;
    this.lease = await this.requestAllowance(3);
  }
  private async requestAllowance(count: 1 | 3): Promise<Lease> {
    const context = this.context;
    const peer = context?.peer;
    const epoch = this.permissionEpoch;
    const generation = this.generation;
    if (!peer?.request) throw new Error("Voice backend unavailable");
    const lease = await peer.request("arm", { count }) as unknown as Lease;
    if (epoch !== this.permissionEpoch || generation !== this.generation || !this.isConnected || scope(context) !== scope(this.context)) {
      // Issuance may have completed after revocation. Revoke only that late token,
      // not a newer allowance another explicit action may have created.
      await peer.request("disarm", { token: lease.token }).catch(() => {});
      throw new Error("Approval was revoked while awaiting the server; instruction was not sent.");
    }
    return lease;
  }
  private async execute(command: Command, manual = false) {
    const lease = manual ? await this.requestAllowance(1) : this.lease;
    if (!lease) throw new Error("No active allowance");
    // Spend the local allowance on an attempted send as well: timeouts must not cause blind retries.
    if (!manual) this.lease = { ...lease, remaining: Math.max(0, lease.remaining - 1) };
    const result = await this.request("execute", { command, token: lease.token });
    this.drafts = this.drafts.filter(d => d.requestId !== command.requestId);
    await this.refresh();
    return result;
  }
  private async propose(command: Command) {
    if (this.lease && this.lease.remaining > 0 && this.lease.expiresAt > Date.now()) return this.execute(command);
    if (this.drafts.length >= 10) throw new Error("Proposal queue full; review or dismiss existing proposals first");
    this.drafts = [...this.drafts, command];
    return { status: "proposed-not-submitted", requestId: command.requestId, message: "User must approve exact text on screen. Do not claim work started." };
  }
  private async handleTool(name: string, input: unknown, _callId: string): Promise<unknown> {
    const data = record(input);
    switch (name) {
      case "list_workers": await this.refresh(); return this.workers.map(w => ({ id: w.id, title: w.title, status: w.status, revision: w.revision, model: w.model }));
      case "read_worker": return this.request("read", { workerId: uuid(data.workerId) });
      case "start_worker": return this.propose({ kind: "start", requestId: crypto.randomUUID(), title: text(data.title, "title", 100), prompt: text(data.prompt, "prompt"), ...(data.model ? { model: text(data.model, "model", MAX_MODEL) } : {}) });
      case "reply_worker": {
        if (!Number.isSafeInteger(data.expectedRevision)) throw new Error("Use latest worker revision");
        return this.propose({ kind: "reply", requestId: crypto.randomUUID(), workerId: uuid(data.workerId), expectedRevision: Number(data.expectedRevision), prompt: text(data.prompt, "prompt") });
      }
      case "go_quiet": this.revoke(); this.muted = true; this.voice?.mute(true); return { status: "microphone-muted", message: "Tap Resume to speak again. Workers continue." };
      default: throw new Error("Unsupported voice tool");
    }
  }
  private run(action: () => unknown | Promise<unknown>) { this.error = ""; void Promise.resolve().then(action).catch(e => this.showError(e)); }
  private submitText(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement; const values = new FormData(form);
    this.run(async () => { await this.propose({ kind: "start", requestId: crypto.randomUUID(), title: text(values.get("title"), "title", 100), prompt: text(values.get("prompt"), "prompt"), ...(values.get("model") ? { model: String(values.get("model")) } : {}) }); form.reset(); });
  }
  render() {
    const c = this.context;
    return html`
      <h2>Voice cockpit <small>· experimental</small></h2>
      <p><strong>${c?.machine.name} / ${c?.state?.selectedProject?.name ?? c?.workspace.projectId} / ${c?.workspace.label}</strong></p>
      <p class="muted">Native OpenAI audio ↔ text-only Pi workers. Set up while parked. Foreground use only: hiding this page or closing this panel disconnects voice. No wake word or locked-screen guarantee.</p>
      <section aria-label="Voice controls">
        <p class="state" role="status">${this.status}</p>
        <p>Start sends microphone audio to OpenAI. Worker text is shared with OpenAI only when requested through voice; automatic alerts contain status and ID only. No raw audio is saved by this plugin.</p>
        <div class="toolbar">
          <button class="primary" ?disabled=${this.connected} @click=${() => this.run(() => this.connectVoice())}>Start voice</button>
          <button ?disabled=${!this.connected} @click=${() => { this.muted = !this.muted; if (this.muted) this.revoke(); this.voice?.mute(this.muted); }}>${this.muted ? "Resume microphone" : "Mute microphone"}</button>
          <button ?disabled=${!this.connected} @click=${() => this.voice?.stopSpeaking()}>Stop speaking</button>
          <button class="danger" ?disabled=${!this.connected} @click=${() => this.shutdown()}>Disconnect voice</button>
        </div>
        <audio controls autoplay aria-label="Voice audio playback"></audio>
        ${this.caption ? html`<p class="caption">${this.caption}</p>` : ""}
      </section>
      <section aria-label="Instruction permission">
        <h3>Instruction permission</h3>
        <p>Default: review every proposed task below. Optional allowance permits ordinary Pi tools—not a sandbox. Disconnect/mute revokes it, but never stops admitted workers.</p>
        <div class="toolbar"><button @click=${() => this.run(() => this.arm())}>Allow 3 instructions · 10 minutes</button><button @click=${() => this.revoke()}>Revoke allowance</button></div>
        <p>${this.lease ? `${this.lease.remaining} instruction(s) left, expires ${new Date(this.lease.expiresAt).toLocaleTimeString()}` : "No hands-free allowance. Screen approval required."}</p>
      </section>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ""}
      ${this.drafts.map(d => html`<article><h3>Proposed ${d.kind === "start" ? d.title : "follow-up"} · NOT submitted</h3><p class="id">${d.workerId ?? "New worker"} · ${d.model ?? "Pi default"} · ${d.requestId}</p><pre>${d.prompt}</pre><div class="toolbar"><button class="primary" @click=${() => this.run(() => this.execute(d, true))}>Approve exact instruction</button><button @click=${() => this.drafts = this.drafts.filter(v => v !== d)}>Dismiss</button></div></article>`)}
      <section><h3>Workers</h3><button @click=${() => this.run(() => this.refresh())}>Refresh status</button><p>Completion means the agent turn settled, not independent verification. Generic Pi forms/dialogs still require the conversation UI.</p>
        ${this.workers.length ? this.workers.map(w => html`<article><strong>${w.title}</strong> · <span class="state">${w.status}</span><p class="id">${w.id} · revision ${w.revision} · ${w.model}</p><div class="toolbar"><button @click=${() => this.run(async () => { this.detail = await this.request("read", { workerId: w.id }) as unknown as Worker; })}>Read text / question</button><button ?disabled=${!w.sessionId} @click=${() => this.run(() => c?.navigate({ machineId: c.machine.id, projectId: c.workspace.projectId, workspaceId: c.workspace.id, sessionId: w.sessionId, view: "chat" }))}>Open conversation</button></div></article>`) : html`<p>No tracked workers in this workspace.</p>`}
        ${this.detail ? html`<article><h3>${this.detail.title}</h3><pre>${this.detail.question ?? this.detail.text}</pre><button @click=${() => this.detail = undefined}>Close detail</button></article>` : ""}
      </section>
      <details><summary>Text fallback and worker model selection</summary><p>Use any available Pi text model, independent of the voice model. Model listing needs a selected, hosted conversation with this package's companion enabled; it never creates a hidden catalog session.</p>
        <button @click=${() => this.run(async () => { const id = c?.state?.selectedSession?.id; if (!id) throw new Error("Select a hosted conversation first, or enter exact provider/model ID manually."); this.models = await this.request("models", { sessionId: id }) as unknown as ModelOption[]; })}>Load available models</button>
        <form @submit=${(e: SubmitEvent) => this.submitText(e)}><label>Title<input name="title" required maxlength="100"></label><label>Task text<textarea name="prompt" required maxlength="16000"></textarea></label><label>Worker model (empty = Pi default)<input name="model" list="voice-models" placeholder="provider/model-id"><datalist id="voice-models">${this.models.map(m => html`<option value=${m.id}>${m.name}</option>`)}</datalist></label><button type="submit">Propose text task</button></form>
      </details>`;
  }
}
if (!customElements.get("compn3rd-voice-panel")) customElements.define("compn3rd-voice-panel", VoicePanel);
export default {
  apiVersion: 4, name: "Voice",
  activate({ html }) { return { contributions: { workspacePanels: [{ id: "voice", title: "Voice", order: 27, render: context => html`<compn3rd-voice-panel .context=${context}></compn3rd-voice-panel>` }] } }; },
} satisfies PiWebPlugin;
