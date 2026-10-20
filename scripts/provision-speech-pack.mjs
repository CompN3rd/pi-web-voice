import { copyFile, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { copySpeechNotices, externalOutput, pack, packageRoot, runtimeNames, speechManifest, validAsset } from "./speech-assets.mjs";

// Explicit operator action only; never invoked by build/install/package hooks.
const { values } = parseArgs({ options: {
  output: { type: "string" }, download: { type: "boolean", default: false }, "from-models": { type: "string" },
} });
const output = await externalOutput(values.output);
const assets = await speechManifest();
async function verifiedFile(path, asset) {
  try { const bytes = await readFile(path); return validAsset(bytes, asset) ? bytes : undefined; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
for (const asset of pack.files) {
  const target = join(output, "models", pack.model, asset.path);
  if (await verifiedFile(target, asset)) { console.log(`Verified existing ${asset.path}`); continue; }
  let bytes = values["from-models"] ? await verifiedFile(join(resolve(values["from-models"]), pack.model, asset.path), asset) : undefined;
  if (bytes) console.log(`Reusing verified ${asset.path}`);
  else {
    if (!values.download) throw new Error(`Missing or invalid ${asset.path}; supply verified --from-models or explicitly opt in with --download`);
    console.log(`Downloading pinned ${asset.path} (${asset.bytes} bytes)`);
    const source = `https://huggingface.co/${pack.model}/resolve/${pack.revision}/${asset.path}`;
    const response = await fetch(source, { signal: AbortSignal.timeout(180_000), credentials: "omit" });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${asset.path}`);
    bytes = Buffer.alloc(asset.bytes);
    let offset = 0;
    for await (const chunk of response.body) {
      if (offset + chunk.length > asset.bytes) throw new Error(`Oversized download: ${asset.path}`);
      bytes.set(chunk, offset); offset += chunk.length;
    }
    if (offset !== asset.bytes || !validAsset(bytes, asset)) throw new Error(`Integrity failure: ${asset.path}`);
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.partial`;
  try { await writeFile(temporary, bytes); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
await mkdir(join(output, "ort"), { recursive: true });
for (const name of runtimeNames) await copyFile(join(packageRoot, "node_modules/onnxruntime-web/dist", name), join(output, "ort", name));
await copySpeechNotices(output);
await writeFile(join(output, "speech-assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
console.log(`Speech pack verified at ${output}\nExport it with npm run speech:export -- --input \"${output}\" --output <absolute-external-file.pivoice>, then copy the file to your phone and explicitly import it in Voice. No server route is needed.\nRetain this directory's provenance and license notices separately from the import file.\nLicense/release review remains required: ${pack.licenseNote}`);
