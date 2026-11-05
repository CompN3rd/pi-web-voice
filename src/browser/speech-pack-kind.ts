/** Only compiled pack kinds select bounds/format; imported files never supply policy. */
export const SPEECH_PACKS = {
  recognition: { magic: "PIVOICE1", maxFileBytes: 64_000_000, maxTotalBytes: 100_000_000, maxFiles: 20 },
  // Pinned inventory is ~116 MB: q8 weights ~92.4 MB, ORT ~21.6 MB,
  // voice ~0.5 MB and embedded phonemizer ~1.5 MB. These are disk bounds, not RAM estimates.
  tts: { magic: "PIVOTTS1", maxFileBytes: 96_000_000, maxTotalBytes: 128_000_000, maxFiles: 12 },
} as const;
export type SpeechPackKind = keyof typeof SPEECH_PACKS;
export function speechPackKind(value: unknown): SpeechPackKind {
  if (value !== "recognition" && value !== "tts") throw new Error("Unknown speech pack kind");
  return value;
}

/** No production download exists for the source-built replacement. */
export const TTS_IMPORT_ONLY_REASON = "TTS download unavailable: the source-built phonemizer has no approved distribution URL. Import a newly exported .pivoice pack with its source/notice handoff; old TTS packs are incompatible.";
