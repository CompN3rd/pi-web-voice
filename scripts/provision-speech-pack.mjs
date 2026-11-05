import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { copySpeechNotices, externalOutput, speechPack, packageRoot, speechManifest, validAsset } from "./speech-assets.mjs";
import { TTS_IMPORT_ONLY_REASON, speechPackKind } from "../src/browser/speech-pack-kind.ts";

import { stageCandidate } from "./tts-source-distribution.mjs";

// Explicit operator action only; never invoked by build/install/package hooks.
const { values } = parseArgs({ options: {
  pack: { type: "string", default: "recognition" },
  output: { type: "string" }, download: { type: "boolean", default: false },
  candidate: { type: "string" },
  "from-models": { type: "string" }, "from-pack": { type: "string" },
} });
const kind = speechPackKind(values.pack);
const pack = speechPack(kind);
if (kind === "tts" && values.download) throw new Error(TTS_IMPORT_ONLY_REASON);
const output = await externalOutput(values.output);
if (values["from-models"] && values["from-pack"]) throw new Error("Choose --from-models or --from-pack, not both");
const fromPack = values["from-pack"] ? await externalOutput(values["from-pack"]) : undefined;
if (kind === "tts") {
  if (!values.candidate) throw new Error("TTS provisioning requires --candidate <verified source-built handoff directory>");
  await stageCandidate(values.candidate, output);
}
const assets = await speechManifest(kind);
const inventory = [...assets, ...pack.files.filter(file => file.path === "README.md").map(file => ({
  ...file, path: `models/${pack.model}/${file.path}`,
  downloadUrl: `https://huggingface.co/${pack.model}/resolve/${pack.revision}/${file.path}`,
}))];
async function verifiedFile(path, asset) {
  try { const bytes = await readFile(path); return validAsset(bytes, asset) ? bytes : undefined; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
for (const asset of inventory) {
  const label = asset.path.startsWith(`models/${pack.model}/`) ? asset.path.slice(`models/${pack.model}/`.length) : asset.path;
  const target = join(output, asset.path);
  if (await verifiedFile(target, asset)) { console.log(`Verified existing ${label}`); continue; }
  const sourcePath = asset.path.startsWith("ort/") ? join(packageRoot, "node_modules/onnxruntime-web/dist", asset.path.slice(4))
    : fromPack ? join(fromPack, asset.path)
    : values["from-models"] && asset.path.startsWith("models/") ? join(resolve(values["from-models"]), asset.path.slice(7)) : undefined;
  let bytes = sourcePath ? await verifiedFile(sourcePath, asset) : undefined;
  if (bytes) console.log(`Reusing verified ${label}`);
  else {
    if (!values.download) throw new Error(`Missing or invalid ${label}; supply verified --from-pack/--from-models${kind === "tts" ? "; TTS is import-only, no download is available" : " or explicitly opt in with --download"}`);
    console.log(`Downloading pinned ${label} (${asset.bytes} bytes)`);
    const response = await fetch(asset.downloadUrl, { signal: AbortSignal.timeout(180_000), credentials: "omit", referrerPolicy: "no-referrer" });
    const final = new URL(response.url);
    const knownHost = asset.path.startsWith("models/")
      ? ["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co"].includes(final.hostname) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.cdn\.hf\.co$/.test(final.hostname)
      : final.hostname === "cdn.jsdelivr.net";
    if (final.protocol !== "https:" || final.username || final.password || final.port || !knownHost) throw new Error("Untrusted speech download final URL");
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${label}`);
    bytes = Buffer.alloc(asset.bytes);
    let offset = 0;
    for await (const chunk of response.body) {
      if (offset + chunk.length > asset.bytes) throw new Error(`Oversized download: ${label}`);
      bytes.set(chunk, offset); offset += chunk.length;
    }
    if (offset !== asset.bytes || !validAsset(bytes, asset)) throw new Error(`Integrity failure: ${label}`);
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.partial`;
  try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
await copySpeechNotices(output, kind);
await writeFile(join(output, "speech-assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
console.log(`${kind} speech pack verified at ${output}\n${kind === "tts" ? "Assemble the pack with npm run tts:assemble -- --input <this-directory> --candidate <verified-build> --output <new-external-directory> --dependency-archives <external-cache>." : `Export it with npm run speech:export -- --input "${output}" --output <absolute-external-file.pivoice>.`} No server route is needed.\nRetain this directory's provenance and license notices separately from the import file.\nLicense/release review remains required: ${pack.licenseNote}`);
