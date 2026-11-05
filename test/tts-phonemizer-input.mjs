import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { externalPath, speechManifest, validAsset } from "../scripts/speech-assets.mjs";

// Opt-in local test input; never read an executable manifest from the supplied
// directory, guess files, or deploy the candidate into the production manifest.
export async function ttsPhonemizerInput() {
  const candidate = process.env.VOICE_TTS_CANDIDATE_FILE;
  const published = process.env.VOICE_TTS_PHONEMIZER_FILE;
  assert.ok(!(candidate && published), "Select only one explicit phonemizer file");
  const filename = candidate ?? published;
  assert.ok(filename, "Set VOICE_TTS_CANDIDATE_FILE (source-built candidate) or VOICE_TTS_PHONEMIZER_FILE (production source-built module); no downloads.");
  const record = JSON.parse(await readFile(new URL("../scripts/phonemizer/candidate.json", import.meta.url), "utf8"));
  const asset = (await speechManifest("tts")).find(asset => asset.path === "phonemizer/phonemizer.js");
  assert.equal(asset.sha256, record.binary.sha256);
  assert.equal(asset.downloadUrl, undefined);
  const bytes = await readFile(await externalPath(filename));
  assert.ok(asset && validAsset(bytes, asset), "Pinned phonemizer integrity");
  return { bytes, asset, candidate: true };
}
