import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { externalOutput, externalPath, pack, speechManifest } from "./speech-assets.mjs";

const header = Buffer.from("PIVOICE1", "ascii");

async function regularOutput(output) {
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Speech export output must be a regular file, not a symlink or directory");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// The CLI always uses the compiled manifest, never metadata from the input pack.
export async function exportSpeechPack(input, output, assets = undefined) {
  input = await externalOutput(input);
  output = await externalPath(output);
  if (extname(output) !== ".pivoice") throw new Error("Speech export --output must end in .pivoice");
  await regularOutput(output);
  assets ??= await speechManifest();
  await mkdir(dirname(output), { recursive: true });
  output = join(await realpath(dirname(output)), basename(output));
  const temporary = await mkdtemp(join(dirname(output), ".pivoice-export-"));
  try {
    const destination = await open(join(temporary, "pack"), "wx", 0o600);
    try {
      await destination.writeFile(header);
      const buffer = Buffer.alloc(64 * 1024);
      for (const asset of assets) {
        const path = join(input, asset.path);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes) throw new Error(`Speech export length/type failure: ${asset.path}`);
        const source = await open(path, "r");
        try {
          const hash = createHash("sha256");
          let remaining = asset.bytes;
          while (remaining > 0) {
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, remaining), null);
            if (!bytesRead) throw new Error(`Speech export truncated asset: ${asset.path}`);
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await destination.writeFile(chunk);
            remaining -= bytesRead;
          }
          if ((await source.read(buffer, 0, 1, null)).bytesRead || hash.digest("hex") !== asset.sha256) throw new Error(`Speech export integrity failure: ${asset.path}`);
        } finally { await source.close(); }
      }
      await destination.sync();
    } finally { await destination.close(); }
    await regularOutput(output);
    await rename(join(temporary, "pack"), output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return header.length + assets.reduce((total, asset) => total + asset.bytes, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } } });
  const bytes = await exportSpeechPack(values.input, values.output);
  console.log(`Exported verified speech pack: ${values.output} (${bytes} bytes).\nCopy this .pivoice file to your phone and explicitly import it in Voice. No server route is needed.\nKeep the source pack's provenance and license notices separately; the import contains only pinned asset bytes.\nLicense/release review remains required: ${pack.licenseNote}`);
}
