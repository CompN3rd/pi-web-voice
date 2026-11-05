import { TTS_MAX_CHUNKS, TTS_MAX_TEXT } from "./tts-contract.js";

export const TTS_TOKEN_BUDGET = 512;
// Model capacity is not a practical synthesis size: 512-token chunks exceeded
// the unchanged inactivity deadline in real single-thread WASM inference.
export const TTS_CHUNK_TOKEN_BUDGET = 128;
export interface TtsTextChunk { text: string; ids: number[]; }
export interface TtsTextEncoder { (text: string): Promise<number[]>; }

/** Conservative English input policy, not language detection. No semantic rewrites:
 * normalize curly quotes/ellipsis, map dashes to the model's em-dash token, and collapse whitespace only. Emoji,
 * non-Latin scripts, combining marks, controls and lone surrogates reject rather
 * than vanish. Unqualified numeric forms, >15 numeric digits and >32-character
 * phonemizer spans reject. Symbol-heavy code/URLs are never interpreted/fetched.
 */
export function normalizeTtsText(text: string): string {
  if (typeof text !== "string" || !text.trim() || text.length > TTS_MAX_TEXT) throw new Error("TTS text");
  const normalized = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[-–—]/g, "—").replace(/…/g, "...").replace(/[\t\r\n]/g, " ").replace(/ +/g, " ").trim();
  if (/[^A-Za-z0-9 ;:,.!?()'"—]/.test(normalized) || !/[A-Za-z0-9]/.test(normalized)) throw new Error("TTS text");
  textSpans(normalized);
  return normalized;
}

const punctuation = /^(?:[;:,.!?()"—]+|\s+)$/u;
const numberExpression = /^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/;
const dottedAbbreviation = /^[A-Za-z](?:\.[A-Za-z])+\.?$/;
// Pinned eSpeak can silently truncate a long number or word before tokenization.
// Conservative input ceilings, not inferred from the model's output-token budget.
const MAX_NUMERIC_DIGITS = 15;
const MAX_PHONEMIZER_SPAN = 32;

/** Keep decimal/grouping/time separators and dotted initials inside their
 * phonemizer input. Signs/ranges are unqualified: mapping a minus to an em dash
 * would erase its meaning. Malformed/mixed numeric expressions fail closed.
 * This preserves input structure, not a promise of correct pronunciation.
 */
function textSpans(text: string): string[] {
  if (/[-–—]\s*\d|\d\s*[-–—]/u.test(text)) throw new Error("TTS text");
  const spans: string[] = [];
  for (const run of text.match(/[^\s;!?()"—]+|[;!?()"—]+|\s+/gu) ?? []) {
    if (punctuation.test(run)) { spans.push(run); continue; }
    const [, leading, core, trailing] = /^([.,:]*)(.*?)([.,:]*)$/.exec(run)!;
    if (/\d/.test(core)) {
      if (leading || (core.match(/\d/g)?.length ?? 0) > MAX_NUMERIC_DIGITS || (/[.,:]/.test(core) && !numberExpression.test(core))) throw new Error("TTS text");
      spans.push(core);
      if (trailing) spans.push(trailing);
    } else if (dottedAbbreviation.test(core)) {
      if (leading) spans.push(leading);
      // A terminal abbreviation dot belongs to the abbreviation, not a pause.
      spans.push(core + (trailing.startsWith(".") ? "." : ""));
      const rest = trailing.startsWith(".") ? trailing.slice(1) : trailing;
      if (rest) spans.push(rest);
    } else {
      spans.push(...run.split(/([:,.]+)/u).filter(Boolean));
    }
  }
  if (spans.some(span => !punctuation.test(span) && span.length > MAX_PHONEMIZER_SPAN)) throw new Error("TTS text");
  return spans;
}

/** Every candidate is encoded without truncation. A balanced split guarantees
 * progress for a long word, and retains every code point. Numeric spans and
 * dotted abbreviations are indivisible; oversized ones reject rather than change meaning.
 * Preparation completes for the entire prefix before any model call is allowed.
 */
export async function planTtsText(text: string, encode: TtsTextEncoder): Promise<TtsTextChunk[]> {
  const normalized = normalizeTtsText(text);
  const result: TtsTextChunk[] = [];
  const queue = [normalized];
  let attempts = 0;
  while (queue.length) {
    if (++attempts > TTS_MAX_CHUNKS * 2 - 1 || result.length + queue.length > TTS_MAX_CHUNKS) throw new Error("TTS text");
    const candidate = queue.shift()!;
    const ids = await encode(candidate);
    if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 0) || ids.length < 3) throw new Error("TTS text");
    if (ids.length <= TTS_CHUNK_TOKEN_BUDGET) { result.push({ text: candidate, ids }); continue; }
    const points = Array.from(candidate);
    if (points.length < 2) throw new Error("TTS text");
    let split = -1;
    let offset = 0;
    const protectedSpans = textSpans(candidate).flatMap(span => {
      const start = offset; offset += span.length;
      return /\d/.test(span) || dottedAbbreviation.test(span) ? [{ start, end: offset }] : [];
    });
    const safe = (i: number) => !protectedSpans.some(span => i > span.start && i < span.end);
    // Prefer a nearby sentence/word boundary without producing tiny recursive splits.
    const lower = Math.max(1, Math.floor(points.length / 4));
    const upper = Math.min(points.length - 1, Math.ceil(points.length * 3 / 4));
    let distance = Infinity;
    for (let i = lower; i <= upper; i++) {
      if (safe(i) && /\s/.test(points[i - 1]) && /\S/.test(points.slice(0, i).join("")) && /\S/.test(points.slice(i).join(""))) {
        const score = Math.abs(i - points.length / 2) - (/[.!?]/.test(points[i - 2] ?? "") ? points.length / 8 : 0);
        if (score < distance) { distance = score; split = i; }
      }
    }
    if (split < 0) {
      // No word boundary: use the nearest safe character boundary, never bisect
      // an atomic expression even when it alone exceeds the token budget.
      for (let i = 1; i < points.length; i++) {
        if (safe(i) && Math.abs(i - points.length / 2) < distance) { distance = Math.abs(i - points.length / 2); split = i; }
      }
    }
    if (split < 0) throw new Error("TTS text");
    queue.unshift(points.slice(0, split).join(""), points.slice(split).join(""));
  }
  return result;
}

export type EnglishPhonemizer = (text: string, language: "en-us") => Promise<string[]>;
export interface FidelityTokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  decode(ids: number[], options: { skip_special_tokens: boolean; clean_up_tokenization_spaces: boolean }): string;
}

/** Small direct adapter, not upstream Kokoro normalization/streaming code.
 * IPA substitutions r→ɹ, ʲ→j, x→k, ɬ→l follow the model's English alphabet
 * (also documented by kokoro-js 1.2.1). No abbreviation/currency/year rewrite.
 * Punctuation is preserved outside eSpeak, which otherwise drops separators.
 */
export async function encodeTtsText(text: string, phonemize: EnglishPhonemizer, tokenizer: FidelityTokenizer): Promise<number[]> {
  const spans = textSpans(text);
  let phonemes = "";
  for (const span of spans) {
    if (punctuation.test(span)) { phonemes += span; continue; }
    const output = await phonemize(span, "en-us");
    if (!Array.isArray(output) || !output.length || output.length > TTS_MAX_TEXT || output.some(part => typeof part !== "string" || part.length > 16_384)) throw new Error("TTS text");
    const part = output.join(" ").trim();
    if (!part) throw new Error("TTS text");
    phonemes += part;
    if (phonemes.length > 32_768) throw new Error("TTS text");
  }
  phonemes = phonemes.replace(/r/g, "ɹ").replace(/ʲ/g, "j").replace(/x/g, "k").replace(/ɬ/g, "l");
  const body = tokenizer.encode(phonemes, { add_special_tokens: false });
  // This character tokenizer has no decoder; sequence decode inserts spaces.
  // Decode individual tokens through the public API to test lossless coverage
  // without confusing formatting separators with the original phonemes.
  const decoded = body.map(id => tokenizer.decode([id], { skip_special_tokens: false, clean_up_tokenization_spaces: false })).join("");
  if (decoded !== phonemes) throw new Error("TTS text");
  const ids = tokenizer.encode(phonemes, { add_special_tokens: true });
  if (ids.length !== body.length + 2 || ids[0] !== ids.at(-1) || !body.every((id, i) => ids[i + 1] === id)) throw new Error("TTS text");
  return ids;
}
