import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscript } from "./transcript-comparison.ts";

test("model round-trip normalization ignores punctuation/case, not added digits or Unicode letters", () => {
  const expected = normalizeTranscript("Hello world.");
  assert.equal(normalizeTranscript("  HELLO,\nworld!  "), expected);
  for (const text of ["Hello world 123", "Hello world é", "Hello world 文", "Hello world +"]) {
    assert.notEqual(normalizeTranscript(text), expected);
  }
});
