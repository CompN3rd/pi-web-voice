import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { externalOutput, packageRoot, validAsset } from "./speech-assets.mjs";
import { bundledLicenses } from "./bundle-notices.mjs";

/** Repository-reviewed evidence; never interpreted by the browser or as release approval. */
export async function dependencySources() {
  const inventory = JSON.parse(await readFile(join(packageRoot, "scripts/dependency-sources.json"), "utf8"));
  const names = inventory.packages.map(item => item.name);
  if (names.length !== Object.keys(bundledLicenses).length || new Set(names).size !== names.length) throw Error("Source inventory package set changed");
  for (const item of inventory.packages) {
    if (bundledLicenses[item.name]?.version !== item.version || !inventory.archives.some(archive => archive.id === item.sourceArchive)) throw Error(`Unreviewed upstream source: ${item.name}`);
  }
  return inventory;
}

export async function verifiedSourceArchive(directory, item) {
  const stat = await lstat(join(directory, item.archive));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) throw Error(`Upstream source length/type mismatch: ${item.archive}`);
  const bytes = await readFile(join(directory, item.archive));
  if (!validAsset(bytes, item)) throw Error(`Upstream source integrity mismatch: ${item.archive}`);
  return bytes;
}

export function sourceArchiveItems(inventory) {
  return [...inventory.archives, ...inventory.embeddedPackages.map(item => item.packageArchive)];
}

/** Public software only; exact-size/hash checks, no redirects, implicit network or archive extraction. */
export async function acquireSourceArchives(inventory, directory, download = false) {
  directory = await externalOutput(directory);
  await mkdir(directory, { recursive: true });
  for (const item of sourceArchiveItems(inventory)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(item.archive) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 300_000_000 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error("Invalid upstream source pin");
    const url = new URL(item.url);
    if (!["https://codeload.github.com", "https://registry.npmjs.org"].includes(url.origin) || url.username || url.password || url.search || url.hash) throw Error("Untrusted upstream source URL");
    try { await verifiedSourceArchive(directory, item); continue; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!download) throw Error(`Missing upstream source archive: ${item.archive}; use --download-sources explicitly`);
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw Error(`Upstream source archive unavailable: ${item.archive}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > item.bytes) throw Error(`Upstream source exceeds pinned size: ${item.archive}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!validAsset(bytes, item)) throw Error(`Upstream source integrity mismatch: ${item.archive}`);
    try { await writeFile(join(directory, item.archive), bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await verifiedSourceArchive(directory, item);
  }
}
