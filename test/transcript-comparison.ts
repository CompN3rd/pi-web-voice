/** Test-only normalization: preserve letters, digits and symbols in every script. */
export function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/gu, " ").trim();
}
