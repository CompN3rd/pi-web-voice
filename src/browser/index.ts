import { LitElement, html, css } from "lit";
import type { PiWebPlugin, WorkspacePanelContext, JsonValue } from "@jmfederico/pi-web/plugin-api";
import { text, MAX_MODEL, type Command, type Lease, type Worker, type ModelOption } from "../protocol.ts";
import { LocalRecognizer } from "./audio.ts";
import { LocalSpeechOutput, SPEECH_CANCELLATION_FAILURE } from "./speech-output.ts";

const scope = (c?: WorkspacePanelContext) => c ? JSON.stringify([c.machine.id, c.workspace.projectId, c.workspace.id, c.state?.selectedSession?.id]) : "";
const replyEligible = (w: Worker) => ["needs-input", "completed", "failed"].includes(w.status);
const targetKey = (w: Worker) => `${w.id}:${w.revision}`;
export class VoicePanel extends LitElement {
  static properties = { context: { attribute: false }, status: { state: true }, workers: { state: true }, drafts: { state: true }, transcript: { state: true }, taskTitle: { state: true }, model: { state: true }, target: { state: true }, models: { state: true }, detail: { state: true }, error: { state: true }, approving: { state: true }, speechStatus: { state: true }, selectedVoice: { state: true } };
  context?: WorkspacePanelContext;
  private status = "Microphone off · prepare local speech or type below";
  private workers: Worker[] = [];
  private drafts: Command[] = [];
  private transcript = "";
  private taskTitle = "";
  private model = "";
  private target = "new";
  private models: ModelOption[] = [];
  private detail?: Worker;
  private error = "";
  private approving = false;
  private recognizer?: LocalRecognizer;
  private speech?: LocalSpeechOutput;
  private speechCancellationSafe = true;
  private get cancellationSafe() { return this.speech?.cancellationSafe ?? this.speechCancellationSafe; }
  private speechStatus = "Text only: select a local English voice.";
  private selectedVoice = "";
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private permissionEpoch = 0;
  private lastScope = "";
  private activeContext?: WorkspacePanelContext;
  private refreshing = false;
  private hide = () => {
    if (document.hidden) { this.shutdown(); this.status = "Page hidden · microphone off; speech stop requested. Workers continue."; }
    else this.requestUpdate();
  };
  static styles = css`
    :host { display:block; color:var(--pi-fg,inherit); padding:16px; max-width:960px; margin:auto; font:inherit; overflow-wrap:anywhere }
    h2,h3 { margin:.5em 0 } p { line-height:1.45 } .muted { opacity:.75 } .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 }
    button,select,input,textarea { font:inherit; color:inherit; background:var(--pi-bg,transparent); border:1px solid var(--pi-border,#888); border-radius:6px; padding:10px; min-height:44px; max-width:100%; box-sizing:border-box }
    button { cursor:pointer } button:disabled { opacity:.5; cursor:default } button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--pi-accent,#5b9aff); outline-offset:2px }
    .primary { border:2px solid var(--pi-accent,#5b9aff) } .danger { border-color:#c66 } section,article { border:1px solid var(--pi-border,#888); border-radius:8px; padding:12px; margin:12px 0 }
    label { display:block; margin:8px 0 } input,textarea,select { width:100% } textarea { min-height:110px } pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:24em; overflow:auto }
    .error { color:var(--pi-error,#e77) } .id { overflow-wrap:anywhere; font-size:.85em } .state { font-weight:600 }
  `;
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.hide);
    this.timer = setInterval(() => {
      const generation = this.generation;
      void this.refresh().catch(error => { if (this.current(generation)) this.showError(error); });
    }, 5000);
  }
  disconnectedCallback() { this.shutdown(); clearInterval(this.timer); document.removeEventListener("visibilitychange", this.hide); super.disconnectedCallback(); }
  protected updated() {
    const key = scope(this.context);
    if (key !== this.lastScope) {
      this.shutdown(); this.activeContext = this.context; this.lastScope = key;
      this.workers = []; this.models = []; this.detail = undefined; this.taskTitle = ""; this.model = ""; this.target = "new"; this.error = "";
      this.run(() => this.refresh());
    }
    if (!this.speech && this.isConnected && !document.hidden) {
      const generation = this.generation;
      this.speech = new LocalSpeechOutput(message => {
        if (!this.current(generation)) return;
        this.speechStatus = message;
        if (message.startsWith("Text only:")) this.selectedVoice = "";
        this.requestUpdate();
      });
      this.speechCancellationSafe = this.speech.cancellationSafe;
      this.requestUpdate();
    }
  }
  private current(generation: number, epoch = this.permissionEpoch) {
    return generation === this.generation && epoch === this.permissionEpoch && this.isConnected && !document.hidden && this.lastScope === scope(this.context);
  }
  private showError(error: unknown) { this.error = error instanceof Error ? error.message : String(error); }
  private async request(operation: string, input: unknown = {}) {
    const context = this.context; const generation = this.generation;
    if (!context?.peer?.request) throw new Error("Paired Voice backend unavailable. Text drafts remain local until exact approval.");
    const result = await context.peer.request(operation, input as JsonValue);
    if (!this.current(generation) || scope(context) !== scope(this.context)) throw new Error("Selection changed; stale result discarded. Accepted work may continue.");
    return result;
  }
  private async refresh() {
    if (!this.context || !this.isConnected || document.hidden || this.refreshing) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const value = await this.request("list");
      if (!Array.isArray(value)) throw new Error("Invalid worker list");
      this.workers = value as unknown as Worker[];
      if (this.target && this.target !== "new" && !this.replyTarget()) {
        this.shutdown(); this.target = ""; this.detail = undefined;
        this.status = "Worker revision changed · draft discarded. Select an exact target again.";
      }
    } finally { if (generation === this.generation) this.refreshing = false; }
  }
  private revoke() {
    this.permissionEpoch++;
    // Capture the old peer: selection changes must revoke the old scope, not the new one.
    void this.activeContext?.peer?.request?.("disarm", {}).catch(() => {});
  }
  private shutdown() {
    this.revoke(); this.generation++; this.refreshing = false;
    this.recognizer?.dispose(); this.recognizer = undefined;
    // Generation fences status callbacks, not the page-global cancellation latch.
    this.speechCancellationSafe = this.speech?.dispose() ?? this.speechCancellationSafe;
    this.speech = undefined; this.selectedVoice = "";
    this.speechStatus = this.cancellationSafe ? "Text only: select a local English voice." : SPEECH_CANCELLATION_FAILURE;
    this.transcript = ""; this.drafts = []; this.approving = false;
    this.status = "Microphone off · prepare local speech again. Workers continue.";
  }
  private replyTarget() { return this.workers.find(w => targetKey(w) === this.target); }
  private changeTarget(value: string) { this.shutdown(); this.target = value; this.status = "Target changed · microphone work and drafts discarded. Prepare again or type below."; }
  private changeModel(value: string) { this.shutdown(); this.model = value; this.status = "Model changed · microphone work and drafts discarded. Prepare again or type below."; }
  private get busy() { return !!this.recognizer && ["preparing", "starting", "recording", "transcribing"].includes(this.recognizer.state); }
  private async prepare() {
    if (!this.cancellationSafe) throw new Error(SPEECH_CANCELLATION_FAILURE);
    if (document.hidden || !this.isConnected || this.busy || this.approving || this.recognizer?.ready) return;
    const generation = this.generation;
    const recognizer = new LocalRecognizer({
      status: message => { if (this.current(generation) && this.recognizer === recognizer) { this.status = message; this.requestUpdate(); } },
      transcript: message => {
        if (this.current(generation) && this.recognizer === recognizer) {
          this.transcript = message; this.drafts = [];
          this.status = "Untrusted local transcript · edit and propose; nothing submitted";
        }
      },
    });
    this.recognizer?.dispose(); this.recognizer = recognizer;
    try { await recognizer.prepare(); }
    catch (error) {
      if (this.current(generation) && this.recognizer === recognizer) this.status = "Microphone off · local preparation failed; prepare explicitly to retry.";
      throw error;
    } finally { if (this.current(generation)) this.requestUpdate(); }
  }
  private async toggleRecording() {
    const recognizer = this.recognizer;
    if (!recognizer || document.hidden) return;
    if (recognizer.state === "recording") { await recognizer.finish(); return; }
    if (!recognizer.ready || this.approving) return;
    const worker = this.replyTarget();
    if (!this.target || (this.target !== "new" && (!worker || !replyEligible(worker)))) throw new Error("Select a new task or an exact settled worker revision first.");
    if (!this.cancellationSafe || this.speech?.cancel() === false) throw new Error(SPEECH_CANCELLATION_FAILURE);
    this.revoke(); this.transcript = ""; this.drafts = [];
    // Target/model changes and worker revision changes dispose this recognizer. Its
    // generation binds this utterance to the exact selection, never a later target.
    try { await recognizer.start(); }
    catch (error) {
      if (this.recognizer === recognizer) this.status = "Microphone off · local capture failed; prepare explicitly to retry.";
      throw error;
    }
  }
  private async requestAllowance(): Promise<Lease> {
    const context = this.context; const peer = context?.peer;
    const epoch = this.permissionEpoch; const generation = this.generation;
    if (!peer?.request) throw new Error("Voice backend unavailable");
    const lease = await peer.request("arm", { count: 1 }) as unknown as Lease;
    if (!this.current(generation, epoch) || scope(context) !== scope(this.context)) {
      await peer.request("disarm", { token: lease.token }).catch(() => {});
      throw new Error("Approval was revoked while awaiting the server; instruction was not sent.");
    }
    return lease;
  }
  private async execute(command: Command) {
    if (this.approving || !this.drafts.includes(command) || this.busy) return;
    const generation = this.generation; const epoch = this.permissionEpoch; const peer = this.context?.peer;
    // Consume the proposal before awaiting anything. An uncertain attempt has no retry button.
    this.drafts = []; this.approving = true;
    let lease: Lease | undefined;
    let attempted = false;
    try {
      lease = await this.requestAllowance();
      if (!this.current(generation, epoch)) return;
      attempted = true;
      await this.request("execute", { command, token: lease.token });
      this.transcript = "";
      await this.refresh();
    } catch (error) {
      if (attempted) throw new Error("Instruction outcome may be unknown. Inspect workers/conversation; do not blindly resubmit. " + (error instanceof Error ? error.message : String(error)));
      throw error;
    } finally {
      if (lease) void peer?.request?.("disarm", { token: lease.token }).catch(() => {});
      if (this.current(generation, epoch)) this.approving = false;
    }
  }
  private propose(event: SubmitEvent) {
    event.preventDefault();
    this.run(() => {
      if (this.busy || this.approving) return;
      const prompt = text(this.transcript, "instruction");
      const worker = this.replyTarget();
      if (this.target !== "new" && (!worker || !replyEligible(worker))) throw new Error("Select an exact settled worker revision first.");
      this.revoke();
      this.drafts = [worker
        ? { kind: "reply", requestId: crypto.randomUUID(), workerId: worker.id, expectedRevision: worker.revision, prompt }
        : { kind: "start", requestId: crypto.randomUUID(), title: text(this.taskTitle, "title", 100), prompt, ...(this.model.trim() ? { model: text(this.model, "model", MAX_MODEL) } : {}) }];
    });
  }
  private run(action: () => unknown | Promise<unknown>) {
    const generation = this.generation; const context = scope(this.context);
    this.error = "";
    void Promise.resolve().then(() => { if (this.current(generation)) return action(); }).catch(error => { if (this.current(generation) && context === scope(this.context)) this.showError(error); });
  }
  private speak(value: string) {
    if (!this.cancellationSafe || this.busy || document.hidden || !this.isConnected) return;
    this.speech?.speak(value.slice(0, 1000));
  }
  render() {
    const c = this.context; const worker = this.replyTarget();
    const recording = this.recognizer?.state === "recording";
    const result = this.detail?.question ?? this.detail?.text ?? "";
    const statuses = this.workers.map(w => `${w.title}: ${w.status}.`).join(" ");
    return html`
      <h2>Local voice <small>· experimental</small></h2>
      <p><strong>${c?.machine.name} / ${c?.state?.selectedProject?.name ?? c?.workspace.projectId} / ${c?.workspace.label}</strong></p>
      <p class="muted">Pixel 8 phone-browser speech · English only. Not driving-validated. Foreground only: hiding, closing, changing context or turning off stops microphone work and requests speech cancellation, not worker cancellation. No cloud speech fallback.</p>
      <section aria-label="Local speech controls">
        <p class="state" role="status">${this.cancellationSafe ? this.status : SPEECH_CANCELLATION_FAILURE}</p>
        <p>Prepare downloads/checks approximately 65 MB of self-hosted speech assets, plus cache overhead. Uses phone storage, memory and battery. Preparation never opens the microphone. Audio stays transient on this device.</p>
        <div class="toolbar">
          <button class="primary" ?disabled=${!this.cancellationSafe || this.approving || this.busy || this.recognizer?.ready} @click=${() => this.run(() => this.prepare())}>Prepare local English speech pack</button>
          <button class="primary" aria-pressed=${recording ? "true" : "false"} ?disabled=${!this.cancellationSafe || this.approving || (!recording && !this.recognizer?.ready) || !this.target || (!!worker && !replyEligible(worker))} @click=${() => this.run(() => this.toggleRecording())}>${recording ? "Finish recording" : "Start recording"}</button>
          <button class="danger" @click=${() => this.shutdown()}>Cancel / voice off</button>
        </div>
        <p>Maximum 20 seconds per recording. Finish only creates an untrusted, editable draft; it never sends an instruction. Cancel requires explicit preparation again.</p>
      </section>
      <section aria-label="Exact instruction">
        <h3>Review every instruction</h3>
        <p>Approved text goes to an ordinary Pi worker with its existing provider costs and tool permissions, not a sandbox. No hands-free permission or spoken approval.</p>
        <form @submit=${(event: SubmitEvent) => this.propose(event)}>
          <label>Instruction target<select .value=${this.target} @change=${(event: Event) => this.changeTarget((event.target as HTMLSelectElement).value)}>
            <option value="">Select an exact target</option><option value="new">New task</option>
            ${this.workers.map(w => html`<option value=${targetKey(w)} ?disabled=${!replyEligible(w)}>Reply: ${w.title} · ${w.id} · revision ${w.revision} · ${w.status}</option>`)}
          </select></label>
          ${worker ? html`<p class="id">Reply to ${worker.id} · revision ${worker.revision} · existing model ${worker.model}</p>` : html`<label>Title<input name="title" ?disabled=${this.approving} required maxlength="100" .value=${this.taskTitle} @input=${(event: Event) => { this.taskTitle = (event.target as HTMLInputElement).value; this.drafts = []; this.revoke(); }}></label>`}
          <label>Editable transcript / task text<textarea name="prompt" required maxlength="16000" ?disabled=${this.busy || this.approving} .value=${this.transcript} @input=${(event: Event) => { this.transcript = (event.target as HTMLTextAreaElement).value; this.drafts = []; this.revoke(); }}></textarea></label>
          ${!worker ? html`<label>Worker model (empty = Pi default)<input name="model" list="voice-models" maxlength="512" .value=${this.model} @input=${(event: Event) => this.changeModel((event.target as HTMLInputElement).value)}><datalist id="voice-models">${this.models.map(m => html`<option value=${m.id}>${m.name}</option>`)}</datalist></label>` : ""}
          <button type="submit" ?disabled=${this.busy || this.approving || !this.target || (!!worker && !replyEligible(worker))}>Propose exact instruction</button>
        </form>
        <details><summary>Text fallback and worker model catalog</summary><p>Typing needs no speech pack, microphone or local voice. Model selection is independent of speech. The catalog requires a selected hosted conversation with the companion enabled; no hidden session is created.</p>
          <button @click=${() => this.run(async () => { const id = c?.state?.selectedSession?.id; if (!id) throw new Error("Select a hosted conversation first, or enter exact provider/model ID manually."); this.models = await this.request("models", { sessionId: id }) as unknown as ModelOption[]; })}>Load available models</button>
        </details>
        ${this.approving ? html`<p role="status">Approval pending · no automatic retries</p>` : ""}
      </section>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ""}
      ${this.drafts.map(d => html`<article aria-label="Exact proposal"><h3>Proposed ${d.kind === "start" ? d.title : "follow-up"} · NOT submitted</h3><p class="id">${d.workerId ? `Reply to ${d.workerId} · revision ${d.expectedRevision} · existing model ${worker?.model}` : `New worker · ${d.model ?? "Pi default"}`} · request ${d.requestId}</p><pre>${d.prompt}</pre><div class="toolbar"><button class="primary" ?disabled=${this.busy || this.approving} @click=${() => this.run(() => this.execute(d))}>Approve exact instruction</button><button @click=${() => { this.drafts = []; this.revoke(); }}>Dismiss</button></div></article>`)}
      <section aria-label="Local playback">
        <h3>Local playback</h3><p role="status" class=${this.cancellationSafe ? "" : "error"}>${this.cancellationSafe ? this.speechStatus : SPEECH_CANCELLATION_FAILURE}</p>
        <label>Local English voice<select .value=${this.selectedVoice} @change=${(event: Event) => { this.selectedVoice = (event.target as HTMLSelectElement).value; this.speech?.select(this.selectedVoice); }}><option value="">Text only · select a voice explicitly</option>${this.speech?.voices().map(v => html`<option value=${v.voiceURI}>${v.name} (${v.lang})</option>`)}</select></label>
        <p>Only voices marked local by the browser/OS are offered. This is not network attestation; Pixel offline acceptance is still required.</p>
        <div class="toolbar"><button ?disabled=${!this.cancellationSafe || this.busy || !this.selectedVoice || !statuses} @click=${() => this.speak(statuses)}>Speak worker status</button><button @click=${() => this.speech?.cancel()}>Stop speaking</button></div>
        ${statuses.length > 1000 ? html`<p>Status playback is truncated to the first 1000 characters.</p>` : ""}
      </section>
      <section><h3>Workers</h3><button @click=${() => this.run(() => this.refresh())}>Refresh status</button><p>Completion means the agent turn settled, not independent verification. Generic Pi forms/dialogs still require the conversation UI.</p>
        ${this.workers.length ? this.workers.map(w => html`<article><strong>${w.title}</strong> · <span class="state">${w.status}</span><p class="id">${w.id} · revision ${w.revision} · ${w.model}</p><div class="toolbar"><button @click=${() => this.run(async () => { this.detail = await this.request("read", { workerId: w.id }) as unknown as Worker; })}>Read text / question</button><button ?disabled=${!w.sessionId} @click=${() => this.run(() => c?.navigate({ machineId: c.machine.id, projectId: c.workspace.projectId, workspaceId: c.workspace.id, sessionId: w.sessionId, view: "chat" }))}>Open conversation</button></div></article>`) : html`<p>No tracked workers in this workspace.</p>`}
        ${this.detail ? html`<article><h3>${this.detail.title}</h3><pre>${result}</pre><p>${result.length > 1000 ? "Playback is truncated: reads only the first 1000 characters. Full text is shown above." : "Playback reads this result/question, at most 1000 characters."}</p><div class="toolbar"><button ?disabled=${!this.cancellationSafe || this.busy || !this.selectedVoice || !result} @click=${() => this.speak(result)}>Speak result / question prefix</button><button @click=${() => { this.speech?.cancel(); this.detail = undefined; }}>Close detail</button></div></article>` : ""}
      </section>`;
  }
}
if (!customElements.get("compn3rd-voice-panel")) customElements.define("compn3rd-voice-panel", VoicePanel);
export default {
  apiVersion: 4, name: "Voice",
  activate({ html }) { return { contributions: { workspacePanels: [{ id: "voice", title: "Voice", order: 27, render: context => html`<compn3rd-voice-panel .context=${context}></compn3rd-voice-panel>` }] } }; },
} satisfies PiWebPlugin;
