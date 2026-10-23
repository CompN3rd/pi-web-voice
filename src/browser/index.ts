import { LitElement, html, css } from "lit";
import type { PiWebPlugin, WorkspacePanelContext, JsonValue } from "@jmfederico/pi-web/plugin-api";
import { text, MAX_MODEL, type Command, type Lease, type Worker, type ModelOption } from "../protocol.ts";
import { LocalRecognizer } from "./audio.ts";
import type { SpeechPreparation } from "./recognition-runtime.ts";
import type { SpeechPackKind } from "./speech-pack-kind.js";
import { inspectSpeechCache, clearSpeechCache, type SpeechPackInfo, type SpeechCacheState } from "./speech-cache.js";
declare const __VOICE_PACKS__: Record<SpeechPackKind, SpeechPackInfo>;
import { ModelSpeechOutput, type ModelSpeechStatus } from "./speech-output.ts";
import { WorkerTtsRuntime } from "./tts-runtime.js";
import { pageSpeechCoordinator } from "./speech-coordinator.js";
import { ttsPrefix } from "./tts-contract.js";

const SPEECH_CANCELLATION_FAILURE = "Audio teardown is uncertain. Microphone and playback blocked; reload this page to recover.";

const scope = (c?: WorkspacePanelContext) => c ? JSON.stringify([c.machine.id, c.workspace.projectId, c.workspace.id, c.state?.selectedSession?.id]) : "";
const replyEligible = (w: Worker) => ["needs-input", "completed", "failed"].includes(w.status);
const targetKey = (w: Worker) => `${w.id}:${w.revision}`;
export class VoicePanel extends LitElement {
  static properties = { context: { attribute: false }, status: { state: true }, workers: { state: true }, drafts: { state: true }, transcript: { state: true }, taskTitle: { state: true }, model: { state: true }, target: { state: true }, models: { state: true }, detail: { state: true }, error: { state: true }, approving: { state: true }, selectedPack: { state: true }, selectedTtsPack: { state: true } };
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
  private detailSequence = 0;
  private error = "";
  private approving = false;
  private recognizer?: LocalRecognizer;
  private pickerSequence = 0;
  private picker?: { id: number; scope: string; kind: SpeechPackKind; input: HTMLInputElement };
  private selectedPack?: File;
  private selectedTtsPack?: File;
  private cacheStates: Partial<Record<SpeechPackKind, SpeechCacheState>> = {};
  private cacheAction?: SpeechPackKind;
  private speech?: ModelSpeechOutput;
  private playback?: { kind: "detail" | "status"; text: string; revisions: Map<string, number>; detailSequence: number };
  private captureTicket?: object;
  private get cancellationSafe() { return pageSpeechCoordinator().safe; }
  private get stopping() { return pageSpeechCoordinator().stopping; }
  private get speechBusy() { return !!this.speech && ["preparing", "synthesizing", "playing", "stopping"].includes(this.speech.state); }
  private get preparationBlocked() { return !this.cancellationSafe || this.stopping || !!this.cacheAction || this.approving || this.busy; }
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribeAudio?: () => void;
  private generation = 0;
  private permissionEpoch = 0;
  private lastScope = "";
  private activeContext?: WorkspacePanelContext;
  private refreshing = false;
  private hide = () => {
    if (document.hidden) {
      // Android's Files picker may hide the page. Retain only its scoped selection
      // ticket, never audio/permission authority. Import still needs a fresh tap.
      this.shutdown(true);
      this.status = "Page hidden · microphone off; speech stop requested. Workers continue.";
    }
    else this.requestUpdate();
  };
  private pageExit = () => this.shutdown();
  private pageReturn = (event: PageTransitionEvent) => { if (event.persisted) this.shutdown(); };
  static styles = css`
    :host { display:block; color:var(--pi-fg,inherit); padding:16px; max-width:960px; margin:auto; font:inherit; overflow-wrap:anywhere }
    h2,h3 { margin:.5em 0 } p { line-height:1.45 } .muted { opacity:.75 } .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 }
    button,select,input,textarea { font:inherit; color:inherit; background:var(--pi-bg,transparent); border:1px solid var(--pi-border,#888); border-radius:6px; padding:10px; min-height:44px; max-width:100%; box-sizing:border-box }
    button { cursor:pointer } button:disabled { opacity:.5; cursor:default } button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--pi-accent,#5b9aff); outline-offset:2px }
    .primary { border:2px solid var(--pi-accent,#5b9aff) } .danger { border-color:#c66 } section,article { border:1px solid var(--pi-border,#888); border-radius:8px; padding:12px; margin:12px 0 }
    label { display:block; margin:8px 0 } input,textarea,select { width:100% } input[type=checkbox] { width:auto; min-height:auto } textarea { min-height:110px } pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:24em; overflow:auto }
    .error { color:var(--pi-error,#e77) } .id { overflow-wrap:anywhere; font-size:.85em } .state { font-weight:600 }
  `;
  connectedCallback() {
    super.connectedCallback();
    this.unsubscribeAudio = pageSpeechCoordinator().subscribe(() => this.requestUpdate());
    document.addEventListener("visibilitychange", this.hide);
    window.addEventListener("pagehide", this.pageExit);
    window.addEventListener("pageshow", this.pageReturn);
    this.timer = setInterval(() => {
      const generation = this.generation;
      void this.refresh().catch(error => { if (this.current(generation)) this.showError(error); });
    }, 5000);
  }
  disconnectedCallback() { this.shutdown(); this.unsubscribeAudio?.(); this.unsubscribeAudio = undefined; clearInterval(this.timer); document.removeEventListener("visibilitychange", this.hide); window.removeEventListener("pagehide", this.pageExit); window.removeEventListener("pageshow", this.pageReturn); super.disconnectedCallback(); }
  protected updated() {
    const key = scope(this.context);
    if (key !== this.lastScope) {
      this.shutdown(); this.activeContext = this.context; this.lastScope = key;
      this.workers = []; this.models = []; this.taskTitle = ""; this.model = ""; this.target = "new"; this.error = "";
      this.run(() => this.refresh());
    }
    if (!this.speech && this.isConnected && !document.hidden) {
      const generation = this.generation;
      this.speech = new ModelSpeechOutput(() => {
        if (this.current(generation)) this.requestUpdate();
      }, () => new WorkerTtsRuntime());
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
      if (this.playback && [...this.playback.revisions].some(([id, revision]) => {
        const current = this.workers.find(w => w.id === id);
        return !current || current.revision > revision;
      })) this.stopPlayback();
      const detail = this.detail;
      if (detail) {
        const current = this.workers.find(w => w.id === detail.id);
        if (!current || current.revision > detail.revision) this.closeDetail();
      }
      if (this.target && this.target !== "new" && !this.replyTarget()) {
        this.shutdown(); this.target = "";
        this.status = "Worker revision changed · draft discarded. Select an exact target again.";
      }
    } finally { if (generation === this.generation) this.refreshing = false; }
  }
  private closeDetail() {
    this.detailSequence++;
    this.detail = undefined;
    if (this.playback?.kind === "detail") this.stopPlayback();
  }
  private async readDetail(worker: Worker) {
    const sequence = ++this.detailSequence;
    if (this.playback?.kind === "detail") this.stopPlayback();
    try {
      const detail = await this.request("read", { workerId: worker.id }) as unknown as Worker;
      if (sequence !== this.detailSequence) return;
      if (detail.id !== worker.id || !Number.isSafeInteger(detail.revision)) throw new Error("Invalid worker detail");
      const current = this.workers.find(w => w.id === worker.id);
      if (!current || detail.revision < current.revision) {
        this.closeDetail();
        this.error = "Worker changed; read its latest result again.";
        return;
      }
      // The user may have started playback of the old detail while this read was pending.
      if (this.playback?.kind === "detail") this.stopPlayback();
      this.detail = detail;
    } catch (error) {
      if (sequence === this.detailSequence) throw error;
    }
  }
  private revoke() {
    this.permissionEpoch++;
    // Capture the old peer: selection changes must revoke the old scope, not the new one.
    void this.activeContext?.peer?.request?.("disarm", {}).catch(() => {});
  }
  private shutdown(preservePicker = false) {
    this.revoke(); this.generation++; this.refreshing = false;
    this.closeDetail();
    if (!preservePicker || this.picker?.scope !== scope(this.context)) this.invalidatePicker();
    this.captureTicket = undefined;
    try { this.recognizer?.dispose(); } catch { pageSpeechCoordinator().latchUnsafe(); }
    this.recognizer = undefined; this.selectedPack = undefined; this.selectedTtsPack = undefined;
    this.playback = undefined;
    const speech = this.speech; this.speech = undefined;
    // The page coordinator owns unfinished teardown even after this wrapper is gone.
    speech?.setEnabled(false);
    if (speech) void speech.dispose().finally(() => this.requestUpdate());
    this.transcript = ""; this.drafts = []; this.approving = false;
    this.status = "Microphone off · prepare local speech again. Workers continue.";
  }
  private async inspectPack(kind: SpeechPackKind) {
    const generation = this.generation;
    const state = await inspectSpeechCache(__VOICE_PACKS__[kind], new URL(kind === "tts" ? "./tts-cache/" : "./speech-cache/", import.meta.url));
    if (this.current(generation)) { this.cacheStates = { ...this.cacheStates, [kind]: state }; this.requestUpdate(); }
  }
  private async clearPack(kind: SpeechPackKind) {
    if (!this.cancellationSafe || this.stopping || this.cacheAction || this.approving || document.hidden || !this.isConnected) return;
    const generation = this.generation;
    const speech = this.speech;
    this.cacheAction = kind;
    this.invalidatePicker();
    if (kind === "tts") { this.selectedTtsPack = undefined; this.playback = undefined; }
    else { this.selectedPack = undefined; this.captureTicket = undefined; }
    this.requestUpdate();
    try {
      await pageSpeechCoordinator().clearPack(kind, async () => { await clearSpeechCache(__VOICE_PACKS__[kind]); });
      if (kind === "tts") speech?.setEnabled(false);
      if (this.current(generation)) await this.inspectPack(kind);
    } finally { this.cacheAction = undefined; this.requestUpdate(); }
  }
  private packBytes(kind: SpeechPackKind) { return __VOICE_PACKS__[kind].assets.reduce((total, asset) => total + asset.bytes, 0); }
  private cacheDescription(kind: SpeechPackKind) {
    const state = this.cacheStates[kind];
    return state ? `${state.state} · ${state.presentFiles}/${state.totalFiles} entries present (not integrity or initialized readiness)` : "Cache presence not inspected";
  }
  private invalidatePicker() {
    this.pickerSequence++;
    this.picker?.input.remove();
    this.picker = undefined;
  }
  private choosePack(kind: SpeechPackKind) {
    if (document.hidden || !this.isConnected || this.preparationBlocked
      || (kind === "tts" ? this.speechBusy || this.speech?.ready : this.speech?.state === "preparing" || this.recognizer?.ready)) return;
    this.invalidatePicker();
    if (kind === "recognition") this.selectedPack = undefined; else this.selectedTtsPack = undefined;
    // One physical input per ticket: a late native picker event can never inherit
    // a newer ticket from a reused input, including same-scope ABA transitions.
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".pivoice"; input.hidden = true;
    const ticket = this.picker = { id: this.pickerSequence, scope: scope(this.context), kind, input };
    const finish = () => {
      const current = this.picker === ticket && ticket.id === this.pickerSequence && this.isConnected
        && ticket.scope === scope(this.context) && ticket.scope === this.lastScope;
      const file = input.files?.[0];
      input.remove();
      if (this.picker === ticket) this.picker = undefined;
      if (current && file) {
        if (kind === "recognition") this.selectedPack = file; else this.selectedTtsPack = file;
        this.requestUpdate();
      }
    };
    input.addEventListener("change", finish, { once: true });
    input.addEventListener("cancel", finish, { once: true });
    document.body.append(input);
    try { input.click(); } catch { this.invalidatePicker(); this.error = "File picker unavailable; use cached preparation or explicit download."; }
  }
  private replyTarget() { return this.workers.find(w => targetKey(w) === this.target); }
  private changeTarget(value: string) { this.shutdown(); this.target = value; this.status = "Target changed · microphone work and drafts discarded. Prepare again or type below."; }
  private changeModel(value: string) { this.shutdown(); this.model = value; this.status = "Model changed · microphone work and drafts discarded. Prepare again or type below."; }
  private get busy() { return !!this.recognizer && ["preparing", "starting", "recording", "transcribing"].includes(this.recognizer.state); }
  private async prepare(options: SpeechPreparation = { source: "cache" }) {
    if (!this.cancellationSafe) throw new Error(SPEECH_CANCELLATION_FAILURE);
    if (document.hidden || !this.isConnected || this.preparationBlocked || this.speech?.state === "preparing" || this.recognizer?.ready) return;
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
    try { await recognizer.prepare(options); }
    catch (error) {
      if (this.current(generation) && this.recognizer === recognizer) this.status = "Microphone off · local preparation failed; prepare explicitly to retry.";
      throw error;
    } finally { if (this.current(generation)) this.requestUpdate(); }
  }
  private async toggleRecording() {
    const recognizer = this.recognizer;
    if (!recognizer || document.hidden) return;
    if (recognizer.state === "recording") { await recognizer.finish(); return; }
    if (!recognizer.ready || this.approving || this.captureTicket || this.cacheAction || this.stopping) return;
    const generation = this.generation, epoch = this.permissionEpoch, target = this.target;
    const ticket = this.captureTicket = {};
    try {
      if (!this.cancellationSafe || await this.speech?.stop() === false) throw new Error(SPEECH_CANCELLATION_FAILURE);
      // Recheck every authority/source condition after asynchronous audio teardown.
      if (!this.current(generation, epoch) || this.captureTicket !== ticket || this.recognizer !== recognizer
        || this.target !== target || !recognizer.ready || this.approving || this.cacheAction || this.stopping) return;
      const worker = this.replyTarget();
      if (!target || (target !== "new" && (!worker || !replyEligible(worker)))) throw new Error("Select a new task or an exact settled worker revision first.");
      if (!this.cancellationSafe) throw new Error(SPEECH_CANCELLATION_FAILURE);
      this.revoke(); this.transcript = ""; this.drafts = []; this.playback = undefined;
      await recognizer.start();
    } catch (error) {
      if (this.recognizer === recognizer) this.status = "Microphone off · local capture failed; prepare explicitly to retry.";
      throw error;
    } finally { if (this.captureTicket === ticket) this.captureTicket = undefined; }
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
  private async prepareTts(options: SpeechPreparation = { source: "cache" }) {
    if (document.hidden || !this.isConnected || this.preparationBlocked || this.speechBusy || this.speech?.ready) return;
    const speech = this.speech;
    if (!speech) throw new Error("Playback controller unavailable; reload this page.");
    await speech.prepare(options);
    this.requestUpdate();
  }
  private stopPlayback() {
    this.playback = undefined;
    if (this.speech) void this.speech.stop().finally(() => this.requestUpdate());
  }
  private speechMessage(status?: ModelSpeechStatus) {
    if (!this.cancellationSafe) return SPEECH_CANCELLATION_FAILURE;
    if (this.stopping) return "Stopping audio · microphone and playback blocked until teardown settles";
    if (!status) return "Playback unprepared · text remains usable";
    if (status.state === "preparing" && status.progress?.phase === "checking") return `Checking TTS pack · ${status.progress.checkedBytes ?? 0} / ${status.progress.totalBytes ?? this.packBytes("tts")} bytes`;
    const messages: Record<ModelSpeechStatus["code"], string> = {
      unprepared: "Playback unprepared · prepare the TTS pack explicitly", preparing: "Preparing local TTS · no audio or microphone",
      ready: "Local TTS ready · enable Heart and tap Speak", synthesizing: "Synthesizing locally · microphone off", playing: "Playing local model audio",
      finished: "Speech finished", stopping: "Stopping audio · microphone and playback blocked until teardown settles",
      stopped: "Speech stopped · prepare TTS explicitly to speak again", failed: "Local TTS failed · prepare explicitly to retry; no fallback",
      "partial-playback": "Partial playback · remaining text was not spoken; prepare explicitly to retry", unsafe: SPEECH_CANCELLATION_FAILURE,
      disposed: "Playback off · prepare explicitly to speak again",
    };
    return messages[status.code];
  }
  private speak(kind: "detail" | "status") {
    const speech = this.speech;
    if (!speech?.ready || !speech.enabled || !this.cancellationSafe || this.stopping || this.busy || this.cacheAction || document.hidden || !this.isConnected) return;
    const detail = this.detail;
    if (kind === "detail" && !detail) return;
    const source = kind === "detail" ? [detail!] : this.workers;
    const value = kind === "detail" ? detail!.question ?? detail!.text : source.map(w => `${w.title}: ${w.status}.`).join(" ");
    const job = this.playback = { kind, text: ttsPrefix(value), revisions: new Map(source.map(w => [w.id, w.revision])), detailSequence: this.detailSequence };
    const generation = this.generation;
    this.error = "";
    // Deliberately not run(): Web Audio create/resume must occur in this gesture stack.
    void speech.speak(job.text).catch(() => {
      if (this.current(generation) && this.playback === job) this.error = "Local playback did not complete. No fallback or automatic replay was attempted.";
    }).finally(() => { if (this.playback === job) this.playback = undefined; this.requestUpdate(); });
  }
  render() {
    const c = this.context; const worker = this.replyTarget();
    const recording = this.recognizer?.state === "recording";
    const result = this.detail?.question ?? this.detail?.text ?? "";
    const statuses = this.workers.map(w => `${w.title}: ${w.status}.`).join(" ");
    return html`
      <h2>Local voice <small>· experimental</small></h2>
      <p><strong>${c?.machine.name} / ${c?.state?.selectedProject?.name ?? c?.workspace.projectId} / ${c?.workspace.label}</strong></p>
      <p class="muted">Pixel 8 phone-browser speech · English only. Not driving-validated. Foreground only: hiding, closing, changing context or turning off stops microphone work and requests speech cancellation, not worker cancellation. No cloud recognition fallback.</p>
      <section aria-label="Local speech controls">
        <p class="state" role="status">${this.cancellationSafe ? this.status : SPEECH_CANCELLATION_FAILURE}</p>
        <p>Speech needs approximately 65 MB plus cache overhead. Prepare uses verified cached files only. Download explicitly contacts Hugging Face/CDN and jsDelivr without credentials or referrer; these hosts see download metadata, never microphone audio. Or import a matching .pivoice file locally. No additional host routes or paid inference service.</p>
        <p>Recognition acquisition: ${this.packBytes("recognition").toLocaleString()} bytes, excluding cache overhead. Download size is not a RAM estimate. Preparing recognition releases an idle TTS model; typed drafts and workers are preserved.</p>
        <p>All acquisition uses phone storage/memory and never opens the microphone. Missing files fail closed; there is no automatic download or cloud recognition fallback.</p>
        <div class="toolbar">
          <button class="primary" ?disabled=${this.preparationBlocked || this.speech?.state === "preparing" || this.recognizer?.ready} @click=${() => this.run(() => this.prepare())}>Prepare local English speech pack</button>
          <button ?disabled=${this.preparationBlocked || this.speech?.state === "preparing" || this.recognizer?.ready} @click=${() => this.run(() => this.prepare({ source: "download" }))}>Download pinned English speech pack · ~65 MB</button>
          <button class="primary" aria-pressed=${recording ? "true" : "false"} ?disabled=${!this.cancellationSafe || this.stopping || this.cacheAction || this.approving || !!this.captureTicket || (!recording && !this.recognizer?.ready) || !this.target || (!!worker && !replyEligible(worker))} @click=${() => this.run(() => this.toggleRecording())}>${recording ? "Finish recording" : "Start recording"}</button>
          <button class="danger" @click=${() => this.shutdown()}>Cancel / voice off</button>
        </div>
        <button aria-label="Import local speech pack (.pivoice)" ?disabled=${this.preparationBlocked || this.speech?.state === "preparing" || this.recognizer?.ready} @click=${() => this.choosePack("recognition")}>Choose recognition pack (.pivoice)</button>
        ${this.selectedPack ? html`<p>Selected ${this.selectedPack.name} (${this.selectedPack.size.toLocaleString()} bytes). Selecting a file has not imported it.</p>
          <button ?disabled=${this.preparationBlocked || this.speech?.state === "preparing" || this.recognizer?.ready} @click=${() => {
            const file = this.selectedPack; this.selectedPack = undefined;
            if (file) this.run(() => this.prepare({ source: "import", file }));
          }}>Import selected speech pack</button>` : ""}
        <p>${this.cacheDescription("recognition")}</p><button @click=${() => this.run(() => this.inspectPack("recognition"))}>Inspect recognition cache</button><button ?disabled=${!this.cancellationSafe || this.stopping || this.cacheAction || this.approving} @click=${() => this.run(() => this.clearPack("recognition"))}>Clear recognition cache</button>
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
        <details><summary>Text fallback and worker model catalog</summary><p>Typing needs no speech pack, microphone or playback voice. Model selection is independent of speech. The catalog requires a selected hosted conversation with the companion enabled; no hidden session is created.</p>
          <button @click=${() => this.run(async () => { const id = c?.state?.selectedSession?.id; if (!id) throw new Error("Select a hosted conversation first, or enter exact provider/model ID manually."); this.models = await this.request("models", { sessionId: id }) as unknown as ModelOption[]; })}>Load available models</button>
        </details>
        ${this.approving ? html`<p role="status">Approval pending · no automatic retries</p>` : ""}
      </section>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ""}
      ${this.drafts.map(d => html`<article aria-label="Exact proposal"><h3>Proposed ${d.kind === "start" ? d.title : "follow-up"} · NOT submitted</h3><p class="id">${d.workerId ? `Reply to ${d.workerId} · revision ${d.expectedRevision} · existing model ${worker?.model}` : `New worker · ${d.model ?? "Pi default"}`} · request ${d.requestId}</p><pre>${d.prompt}</pre><div class="toolbar"><button class="primary" ?disabled=${this.busy || this.approving} @click=${() => this.run(() => this.execute(d))}>Approve exact instruction</button><button @click=${() => { this.drafts = []; this.revoke(); }}>Dismiss</button></div></article>`)}
      <section aria-label="Model speech playback">
        <h3>Local model playback · English Heart</h3>
        <p>Kokoro af_heart runs in this browser at normal speed. No OS, Google/system, cloud speech or alternate-voice fallback. Preparing this pack releases idle recognition resources, preserving typed drafts and workers. Only one speech model is resident in this page; other tabs are not controlled.</p>
        <p>TTS acquisition: ${this.packBytes("tts").toLocaleString()} bytes, excluding cache overhead. This includes a separate runtime copy and is not a RAM estimate. Download contacts pinned Hugging Face/CDN and jsDelivr assets without credentials/referrer. Import and cached preparation make no distribution requests.</p>
        <p role="status" class=${this.cancellationSafe ? "" : "error"}>${this.speechMessage(this.speech?.status)}</p>
        <div class="toolbar">
          <button ?disabled=${this.preparationBlocked || this.speechBusy || this.speech?.ready} @click=${() => this.run(() => this.prepareTts())}>Prepare cached TTS pack</button>
          <button ?disabled=${this.preparationBlocked || this.speechBusy || this.speech?.ready} @click=${() => this.run(() => this.prepareTts({ source: "download" }))}>Download pinned TTS pack</button>
          <button aria-label="Import TTS pack (.pivoice)" ?disabled=${this.preparationBlocked || this.speechBusy || this.speech?.ready} @click=${() => this.choosePack("tts")}>Choose TTS pack (.pivoice)</button>
        </div>
        ${this.selectedTtsPack ? html`<p>Selected TTS file ${this.selectedTtsPack.name} (${this.selectedTtsPack.size.toLocaleString()} bytes). Selecting a file performs no import.</p><button ?disabled=${this.preparationBlocked || this.speechBusy || this.speech?.ready} @click=${() => {
          const file = this.selectedTtsPack; this.selectedTtsPack = undefined;
          if (file) this.run(() => this.prepareTts({ source: "import", file }));
        }}>Import selected TTS pack</button>` : ""}
        <label><input type="checkbox" aria-label="Enable English Heart playback" .checked=${this.speech?.enabled ?? false} ?disabled=${!this.cancellationSafe || this.stopping} @change=${(event: Event) => { this.speech?.setEnabled((event.target as HTMLInputElement).checked); this.requestUpdate(); }}>Enable English Heart playback · preparation alone never speaks</label>
        <p>English-only; unsupported symbols/scripts, signed numbers/ranges, numeric spans over 15 digits and words/identifiers over 32 characters are rejected before audio. Other code, names and numbers may still be pronounced incorrectly. Playback reads the explicitly labelled prefix, not the entire result. Text is never interpreted as commands.</p>
        <div class="toolbar"><button ?disabled=${!this.cancellationSafe || this.stopping || this.busy || this.cacheAction || !this.speech?.ready || !this.speech.enabled || !statuses} @click=${() => this.speak("status")}>Speak worker status</button><button @click=${() => this.stopPlayback()}>Stop speaking</button></div>
        <p>Stop cancels preparation/synthesis/playback and releases TTS weights; prepare explicitly to speak again. It does not clear drafts or stop coding workers.</p>
        <details><summary>Exact status playback prefix · ${ttsPrefix(statuses).length} characters</summary><pre>${ttsPrefix(statuses)}</pre><p>Status is a captured revision snapshot, not a live claim.</p></details>
        <p>${this.cacheDescription("tts")}</p><button @click=${() => this.run(() => this.inspectPack("tts"))}>Inspect TTS cache</button><button ?disabled=${!this.cancellationSafe || this.stopping || this.cacheAction || this.approving} @click=${() => this.run(() => this.clearPack("tts"))}>Clear TTS cache</button>
        <details><summary>Local TTS diagnostics</summary><pre aria-label="Local TTS diagnostics output">${JSON.stringify({ pack: __VOICE_PACKS__.tts.cacheName, state: this.speech?.state ?? "unprepared", enabled: this.speech?.enabled ?? false, safe: this.cancellationSafe, stopping: this.stopping, checkedBytes: this.speech?.status.progress?.checkedBytes ?? 0 }, null, 2)}</pre><p>No task text, phonemes or audio is included or forwarded. Reload the full page when upgrading from OS-synthesis builds.</p></details>
      </section>
      <section><h3>Workers</h3><button @click=${() => this.run(() => this.refresh())}>Refresh status</button><p>Completion means the agent turn settled, not independent verification. Generic Pi forms/dialogs still require the conversation UI.</p>
        ${this.workers.length ? this.workers.map(w => html`<article><strong>${w.title}</strong> · <span class="state">${w.status}</span><p class="id">${w.id} · revision ${w.revision} · ${w.model}</p><div class="toolbar"><button @click=${() => this.run(() => this.readDetail(w))}>Read text / question</button><button ?disabled=${!w.sessionId} @click=${() => this.run(() => c?.navigate({ machineId: c.machine.id, projectId: c.workspace.projectId, workspaceId: c.workspace.id, sessionId: w.sessionId, view: "chat" }))}>Open conversation</button></div></article>`) : html`<p>No tracked workers in this workspace.</p>`}
        ${this.detail ? html`<article><h3>${this.detail.title}</h3><pre>${result}</pre>${result.length > 1000 ? html`<details><summary>Exact result playback prefix · ${ttsPrefix(result).length} characters</summary><pre>${ttsPrefix(result)}</pre></details>` : html`<p>Exact playback prefix: the ${ttsPrefix(result).length}-character text shown above.</p>`}<p>${result.length > 1000 ? "Playback is truncated: reads up to the first 1000 characters. Full text is shown above." : "Playback reads this result/question, at most 1000 characters."}</p><div class="toolbar"><button ?disabled=${!this.cancellationSafe || this.stopping || this.busy || this.cacheAction || !this.speech?.ready || !this.speech.enabled || !result} @click=${() => this.speak("detail")}>Speak result / question prefix</button><button @click=${() => this.closeDetail()}>Close detail</button></div></article>` : ""}
      </section>`;
  }
}
if (!customElements.get("compn3rd-voice-panel")) customElements.define("compn3rd-voice-panel", VoicePanel);
export default {
  apiVersion: 4, name: "Voice",
  activate({ html }) { return { contributions: { workspacePanels: [{ id: "voice", title: "Voice", order: 27, render: context => html`<compn3rd-voice-panel .context=${context}></compn3rd-voice-panel>` }] } }; },
} satisfies PiWebPlugin;
