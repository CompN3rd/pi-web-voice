export interface LocalSpeechOutputDependencies {
  synthesis?: Pick<SpeechSynthesis, "getVoices" | "speak" | "cancel" | "addEventListener" | "removeEventListener">;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export const SPEECH_CANCELLATION_FAILURE = "Speech cancellation failed · audio may still be playing. Microphone and playback blocked; reload this page to recover.";

// Synthesis is page-global. Failed cancellation stays unsafe across wrapper/panel
// disposal; only a page reload resets this latch, never a late utterance callback.
const cancellationSafety = new WeakMap<NonNullable<LocalSpeechOutputDependencies["synthesis"]>, { safe: boolean }>();

function browserDependencies(): LocalSpeechOutputDependencies {
  return {
    synthesis: typeof speechSynthesis === "undefined" ? undefined : speechSynthesis,
    createUtterance: typeof SpeechSynthesisUtterance === "undefined" ? undefined : text => new SpeechSynthesisUtterance(text),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: timer => clearTimeout(timer),
  };
}

function eligible(voice: SpeechSynthesisVoice): boolean {
  return voice.localService === true && !!voice.voiceURI && /^en(?:-[a-z0-9]+)*$/i.test(voice.lang);
}

/**
 * Foreground, explicitly selected OS-local English TTS; no default/remote fallback.
 * localService is an OS assertion, not network attestation. The caller must cancel
 * before microphone capture and on context change/page hide; this owns no capture.
 */
export class LocalSpeechOutput {
  private selected?: string;
  private disposed = false;
  private readonly safety: { safe: boolean };
  private active?: { utterance: SpeechSynthesisUtterance; timer?: ReturnType<typeof setTimeout> };
  private readonly voicesChanged = () => {
    if (this.disposed) return;
    if (!this.cancellationSafe) { this.onStatus(SPEECH_CANCELLATION_FAILURE); return; }
    if (this.selected && !this.resolveSelected()) {
      this.selected = undefined;
      if (!this.stop()) { this.onStatus(SPEECH_CANCELLATION_FAILURE); return; }
      this.onStatus("Text only: selected local English voice is no longer available. Select a voice again.");
    } else if (!this.active) {
      this.onStatus(this.selected ? "Local English voice selected." : this.voices().length
        ? "Text only: select a local English voice to enable speech."
        : "Text only: no local English speech voice is available.");
    }
  };

  constructor(private readonly onStatus: (message: string) => void,
    private readonly dependencies: LocalSpeechOutputDependencies = browserDependencies()) {
    const synthesis = this.dependencies.synthesis;
    this.safety = (synthesis && cancellationSafety.get(synthesis)) ?? { safe: true };
    if (synthesis) cancellationSafety.set(synthesis, this.safety);
    this.dependencies.synthesis?.addEventListener("voiceschanged", this.voicesChanged);
    this.voicesChanged();
  }

  get cancellationSafe(): boolean { return this.safety.safe; }

  private inventory(): SpeechSynthesisVoice[] {
    if (this.disposed || !this.cancellationSafe || !this.dependencies.createUtterance) return [];
    try { return this.dependencies.synthesis?.getVoices() ?? []; }
    catch { return []; }
  }

  voices(): Array<{ voiceURI: string; name: string; lang: string }> {
    return this.inventory().filter(eligible).map(({ voiceURI, name, lang }) => ({ voiceURI, name, lang }));
  }

  private resolveSelected(): SpeechSynthesisVoice | undefined {
    const matches = this.inventory().filter(voice => voice.voiceURI === this.selected);
    // An ambiguous URI must not silently choose a different engine.
    return matches.length === 1 && eligible(matches[0]) ? matches[0] : undefined;
  }

  select(voiceURI: string): void {
    if (this.disposed) return;
    const stopped = this.stop();
    this.selected = voiceURI || undefined;
    if (!stopped) {
      this.selected = undefined;
      this.onStatus(SPEECH_CANCELLATION_FAILURE);
      return;
    }
    if (!this.resolveSelected()) {
      this.selected = undefined;
      this.onStatus("Text only: choose an available local English voice.");
      return;
    }
    this.onStatus("Local English voice selected.");
  }

  speak(text: string): void {
    if (this.disposed) return;
    if (!this.stop()) {
      this.onStatus(SPEECH_CANCELLATION_FAILURE);
      return;
    }
    // Reject rather than silently reading only part of a result. There is no queue.
    if (!text.trim() || text.length > 1000) {
      this.onStatus("Text only: speech requires non-empty text of at most 1000 characters.");
      return;
    }
    const voice = this.resolveSelected();
    if (!voice) {
      this.selected = undefined;
      this.onStatus("Text only: select an available local English voice before speaking.");
      return;
    }
    try {
      const utterance = this.dependencies.createUtterance!(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      const active: NonNullable<LocalSpeechOutput["active"]> = { utterance };
      this.active = active;
      const finish = (message: string, cancel: boolean) => {
        if (this.disposed || this.active !== active) return;
        this.onStatus(this.stop(cancel) ? message : SPEECH_CANCELLATION_FAILURE);
      };
      utterance.onend = () => finish("Local speech finished.", false);
      utterance.onerror = () => finish("Text only: local speech failed; no fallback was used.", true);
      active.timer = this.dependencies.setTimeout(() => finish("Text only: local speech timed out.", true), 30_000);
      this.dependencies.synthesis!.speak(utterance);
      if (this.active === active) this.onStatus("Speaking with the selected local English voice.");
    } catch {
      this.onStatus(this.stop() ? "Text only: local speech failed; no fallback was used." : SPEECH_CANCELLATION_FAILURE);
    }
  }

  private stop(cancel = true): boolean {
    const active = this.active;
    this.active = undefined; // Fence callbacks before calling the browser's cancel().
    if (!active) return this.cancellationSafe;
    active.utterance.onend = null;
    active.utterance.onerror = null;
    if (active.timer !== undefined) this.dependencies.clearTimeout(active.timer);
    if (cancel) {
      try { this.dependencies.synthesis?.cancel(); }
      catch { this.safety.safe = false; return false; }
    }
    return this.cancellationSafe;
  }

  cancel(): boolean {
    if (this.disposed) return this.cancellationSafe;
    const safe = this.stop();
    this.onStatus(safe ? "Local speech canceled." : SPEECH_CANCELLATION_FAILURE);
    return safe;
  }

  dispose(): boolean {
    if (this.disposed) return this.cancellationSafe;
    this.disposed = true;
    this.selected = undefined;
    this.dependencies.synthesis?.removeEventListener("voiceschanged", this.voicesChanged);
    return this.stop();
  }
}
