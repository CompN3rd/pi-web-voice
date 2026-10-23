export interface PcmCapture { stop(): void | Promise<void>; }
export type OpenPcmCapture = (signal: AbortSignal, samples: (pcm: Float32Array) => void, failed: (error: Error) => void) => Promise<PcmCapture>;

/** A rejected open/stop with this category cannot certify that the owned graph is silent. */
export class CaptureTeardownError extends Error {
  constructor() { super("Microphone teardown uncertain; reload this page"); this.name = "CaptureTeardownError"; }
}

export const openPcmCapture: OpenPcmCapture = async (signal, samples, failed) => {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Local microphone capture requires HTTPS or device-local localhost");
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let resume: Promise<void> | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const endedTracks = new Set<MediaStreamTrack>();
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    let resolve!: () => void, reject!: (error: Error) => void;
    stopping = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Abort/event callers need not await, but the owner still observes this same settlement.
    void stopping.catch(() => {});
    let safe = true;
    const attempt = (action: () => void) => { try { action(); } catch { safe = false; } };
    // Every track stops synchronously before graph promises, even if another stop throws.
    let tracks: MediaStreamTrack[] = [];
    attempt(() => { tracks = stream.getTracks(); });
    for (const track of tracks) attempt(() => track.stop());
    attempt(() => signal.removeEventListener("abort", abort));
    for (const track of endedTracks) attempt(() => track.removeEventListener("ended", ended));
    endedTracks.clear();
    if (node) {
      attempt(() => { node!.port.onmessage = null; });
      attempt(() => { node!.onprocessorerror = null; });
      attempt(() => node!.port.close());
      attempt(() => node!.disconnect());
    }
    if (source) attempt(() => source!.disconnect());
    let close = Promise.resolve();
    if (context) { try { close = Promise.resolve(context.close()); } catch { safe = false; } }
    void Promise.allSettled([close, ...(resume ? [resume] : [])]).then(results => {
      if (!safe || results[0].status !== "fulfilled" || (context && context.state !== "closed")) reject(new CaptureTeardownError());
      else resolve();
      source = undefined; node = undefined; context = undefined; resume = undefined;
    });
    return stopping;
  };
  const abort = () => { void stop(); };
  const ended = () => {
    if (stopped) return;
    void stop();
    failed(new Error("Microphone ended"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted(); // Late permission grants cannot retain a microphone.
    context = new AudioContext();
    if (!context.audioWorklet) throw new Error("AudioWorklet is required for local speech");
    await context.audioWorklet.addModule(new URL("./recognition-worklet.js", import.meta.url));
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "local-recognition-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = event => { if (!stopped && event.data instanceof Float32Array) samples(event.data); };
    node.onprocessorerror = () => {
      if (stopped) return;
      void stop();
      failed(new Error("Microphone processing failed"));
    };
    source = context.createMediaStreamSource(stream);
    source.connect(node);
    // Processor outputs zeroes, never microphone loopback; connection keeps the graph rendering.
    node.connect(context.destination);
    for (const track of stream.getTracks()) {
      endedTracks.add(track);
      track.addEventListener("ended", ended, { once: true });
    }
    resume = Promise.resolve(context.resume());
    await resume;
    signal.throwIfAborted();
    return { stop };
  } catch (error) { await stop(); throw error; }
};
