export interface LocalSpeechOutputDependencies {
  synthesis?: Pick<SpeechSynthesis, "getVoices" | "speak" | "cancel" | "addEventListener" | "removeEventListener">;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

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
  private cancellationFailed = false;
  private active?: { utterance: SpeechSynthesisUtterance; timer?: ReturnType<typeof setTimeout> };
  private readonly voicesChanged = () => {
    if (this.disposed) return;
    if (this.selected && !this.resolveSelected()) {
      this.selected = undefined;
      this.stop();
      this.onStatus("Text only: selected local English voice is no longer available. Select a voice again.");
    } else if (!this.active) {
      this.onStatus(this.selected ? "Local English voice selected." : this.voices().length
        ? "Text only: select a local English voice to enable speech."
        : "Text only: no local English speech voice is available.");
    }
  };

  constructor(private readonly onStatus: (message: string) => void,
    private readonly dependencies: LocalSpeechOutputDependencies = browserDependencies()) {
    this.dependencies.synthesis?.addEventListener("voiceschanged", this.voicesChanged);
    this.voicesChanged();
  }

  private inventory(): SpeechSynthesisVoice[] {
    if (this.disposed || this.cancellationFailed || !this.dependencies.createUtterance) return [];
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
    if (!stopped || !this.resolveSelected()) {
      this.selected = undefined;
      this.onStatus("Text only: choose an available local English voice.");
      return;
    }
    this.onStatus("Local English voice selected.");
  }

  speak(text: string): void {
    if (this.disposed) return;
    if (!this.stop()) {
      this.onStatus("Text only: speech cancellation failed.");
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
        this.stop(cancel);
        this.onStatus(message);
      };
      utterance.onend = () => finish("Local speech finished.", false);
      utterance.onerror = () => finish("Text only: local speech failed; no fallback was used.", true);
      active.timer = this.dependencies.setTimeout(() => finish("Text only: local speech timed out.", true), 30_000);
      this.dependencies.synthesis!.speak(utterance);
      if (this.active === active) this.onStatus("Speaking with the selected local English voice.");
    } catch {
      this.stop();
      this.onStatus("Text only: local speech failed; no fallback was used.");
    }
  }

  private stop(cancel = true): boolean {
    const active = this.active;
    this.active = undefined; // Fence callbacks before calling the browser's cancel().
    if (!active) return !this.cancellationFailed;
    active.utterance.onend = null;
    active.utterance.onerror = null;
    if (active.timer !== undefined) this.dependencies.clearTimeout(active.timer);
    if (cancel) {
      try { this.dependencies.synthesis?.cancel(); }
      catch { this.cancellationFailed = true; return false; }
    }
    return true;
  }

  cancel(): void {
    if (this.disposed) return;
    this.onStatus(this.stop() ? "Local speech canceled." : "Text only: speech cancellation failed.");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selected = undefined;
    this.dependencies.synthesis?.removeEventListener("voiceschanged", this.voicesChanged);
    this.stop();
  }
}
