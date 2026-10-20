import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit owner opt-in. Never run from build, install, prepare, or package lifecycle hooks.
if (!process.argv.includes("--download")) {
  console.error("Opt in to public model downloads with: npm run speech:provision -- --download\nNo credentials or inference service are used. Model bytes remain outside git in dist/browser/speech/.");
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(await readFile(new URL("./speech-pack.json", import.meta.url), "utf8"));
  const root = new URL(`../dist/browser/speech/models/${manifest.model}/`, import.meta.url);
  for (const asset of manifest.files) {
    const source = `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${asset.path}`;
    const target = new URL(asset.path, root);
    const valid = bytes => bytes.length === asset.bytes && createHash("sha256").update(bytes).digest("hex") === asset.sha256;
    try { if (valid(await readFile(target))) { console.log(`Verified ${asset.path}`); continue; } } catch (error) { if (error.code !== "ENOENT") throw error; }
    console.log(`Downloading pinned ${asset.path} (${asset.bytes} bytes)`);
    const response = await fetch(source, { signal: AbortSignal.timeout(180_000), credentials: "omit" });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${asset.path}`);
    const bytes = Buffer.alloc(asset.bytes);
    let offset = 0;
    for await (const chunk of response.body) {
      if (offset + chunk.length > asset.bytes) throw new Error(`Oversized download: ${asset.path}`);
      bytes.set(chunk, offset); offset += chunk.length;
    }
    if (offset !== asset.bytes || !valid(bytes)) throw new Error(`Integrity failure: ${asset.path}`);
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    const temporary = new URL(`${asset.path}.partial`, root);
    try { await writeFile(temporary, bytes); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  await writeFile(new URL("../dist/browser/speech/speech-pack-provenance.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Speech pack provisioned and verified. Run npm run build (or build:speech during integration). Browser prepare() separately opts in to downloading these self-hosted files.\nLicense/release review remains required: " + manifest.licenseNote);
}
