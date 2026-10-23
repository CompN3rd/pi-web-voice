/** Only plugin audio in this document is coordinated; other tabs/host audio are not controlled. */
export interface SpeechOwner {
  readonly kind: "recognition" | "tts";
  readonly phase: "idle" | "preparing" | "active" | "stopping";
  release(): boolean | Promise<boolean>;
}

/** A failed teardown is irreversible for this document, including panel remounts. */
export class SpeechCoordinator {
  private owner?: SpeechOwner;
  private incoming?: SpeechOwner;
  private transition?: object;
  private unsafe = false;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* UI observers cannot certify or alter teardown. */ } } }

  get safe(): boolean { return !this.unsafe; }
  get stopping(): boolean { return !!this.transition || this.owner?.phase === "stopping"; }
  latchUnsafe(): void { this.unsafe = true; this.notify(); }

  /** Vacant acquisition is synchronous, so no gesture is deferred through this coordinator. */
  acquire(next: SpeechOwner): void | Promise<void> {
    if (!this.safe) throw new Error("Audio unsafe; reload this page");
    if (this.transition) throw new Error("Speech resource handoff is busy");
    if (this.owner === next) return;
    const previous = this.owner;
    if (!previous) { this.owner = next; return; }
    if (previous.phase === "preparing" || previous.phase === "stopping"
      || (previous.phase === "active" && (previous.kind === "recognition" || next.kind === "tts"))) {
      throw new Error("Speech runtime is busy");
    }
    const ticket = this.transition = {};
    this.incoming = next;
    // Install the reservation before calling user code: releases/callbacks may reenter.
    let released: boolean | Promise<boolean>;
    try { released = previous.release(); }
    catch { released = false; }
    return Promise.resolve(released).then(safe => {
      if (!safe) this.latchUnsafe();
      if (!this.safe) throw new Error("Audio unsafe; reload this page");
      if (this.transition !== ticket || this.incoming !== next) throw new DOMException("Speech acquisition canceled", "AbortError");
      this.owner = next;
    }, () => {
      this.latchUnsafe();
      throw new Error("Audio unsafe; reload this page");
    }).finally(() => {
      if (this.transition === ticket) {
        this.transition = undefined;
        this.incoming = undefined;
        if (this.owner === previous) this.owner = undefined;
      }
      this.notify();
    });
  }

  /** Cancel only the selected pack's resident use, then clear its exact cache under a page reservation.
   * The caller supplies the compiled-cache delete operation; this never clears another pack or resets safety.
   */
  async clearPack(kind: SpeechOwner["kind"], clearCache: () => Promise<void>): Promise<void> {
    if (this.transition || this.owner?.phase === "stopping"
      || (this.owner?.kind !== kind && this.owner?.phase === "preparing")) throw new Error("Speech resource handoff is busy");
    const ticket = this.transition = {};
    const selected = this.owner?.kind === kind ? this.owner : undefined;
    try {
      if (selected) {
        let safe = false;
        try { safe = await selected.release(); } catch { /* Uncertain teardown is latched below. */ }
        if (!safe) { this.latchUnsafe(); throw new Error("Audio unsafe; reload this page"); }
        if (this.owner === selected) this.owner = undefined;
      }
      await clearCache();
    } finally {
      if (this.transition === ticket) this.transition = undefined;
      this.notify();
    }
  }

  owns(owner: SpeechOwner): boolean { return this.safe && !this.transition && this.owner === owner; }
  release(owner: SpeechOwner): void {
    if (this.incoming === owner) this.incoming = undefined;
    if (this.owner === owner) this.owner = undefined;
    // Never clear a transition here: unfinished teardown retains exclusive ownership.
    this.notify();
  }
}

const coordinatorKey = Symbol.for("compn3rd.voice.speech-coordinator.v1");
/** Stored on the document rather than a module/context; duplicate bundles share the safety latch. */
export function pageSpeechCoordinator(): SpeechCoordinator {
  const scope = (typeof document === "undefined" ? globalThis : document) as unknown as Record<symbol, SpeechCoordinator | undefined>;
  return scope[coordinatorKey] ??= new SpeechCoordinator();
}
