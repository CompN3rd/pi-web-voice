export interface PcmCapture { stop(): void; }
export type OpenPcmCapture = (signal: AbortSignal, samples: (pcm: Float32Array) => void, failed: (error: Error) => void) => Promise<PcmCapture>;

export const openPcmCapture: OpenPcmCapture = async (signal, samples, failed) => {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Local microphone capture requires HTTPS or device-local localhost");
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Tracks stop synchronously, before any graph teardown or inference.
    stream.getTracks().forEach(track => track.stop());
    signal.removeEventListener("abort", stop);
    if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); }
    source?.disconnect();
    if (context) void context.close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted(); // Late permission grants cannot retain a microphone.
    context = new AudioContext();
    if (!context.audioWorklet) throw new Error("AudioWorklet is required for local speech");
    await context.audioWorklet.addModule(new URL("./recognition-worklet.js", import.meta.url));
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "local-recognition-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = event => { if (!stopped && event.data instanceof Float32Array) samples(event.data); };
    node.onprocessorerror = () => { if (!stopped) { stop(); failed(new Error("Microphone processing failed")); } };
    source = context.createMediaStreamSource(stream);
    source.connect(node);
    // Processor outputs zeroes, never microphone loopback; connection keeps the graph rendering.
    node.connect(context.destination);
    for (const track of stream.getTracks()) track.addEventListener("ended", () => {
      if (!stopped) { stop(); failed(new Error("Microphone ended")); }
    }, { once: true });
    await context.resume();
    signal.throwIfAborted();
    return { stop };
  } catch (error) { stop(); throw error; }
};
