import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile, rename, rm, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { bundledLicenses, bundleNoticeText } from "./bundle-notices.mjs";
import { externalOutput, externalPath, packageRoot, sha256, speechManifest, speechPack, validAsset, copySpeechNotices } from "./speech-assets.mjs";
import { exportSpeechPack } from "./export-speech-pack.mjs";

const candidatePin = async () => JSON.parse(await readFile(join(packageRoot, "scripts/phonemizer/candidate.json"), "utf8"));
const describe = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
async function regularBytes(path, expected) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) throw Error(`Source handoff length/type mismatch: ${path}`);
  const bytes = await readFile(path);
  if (!validAsset(bytes, expected)) throw Error(`Source handoff integrity mismatch: ${path}`);
  return bytes;
}

/** Producer bytes are checked against repository pins, not producer-supplied hashes. */
export async function candidateFiles(directory, staged = false) {
  directory = staged ? await externalOutput(directory) : await externalPath(directory);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error("Candidate directory must not be a symlink");
  // Build work/toolchain symlinks are not distribution inputs. Read only the four fixed handoff files.
  const pin = await candidatePin();
  const mappingPath = join(directory, staged ? "phonemizer-source/SOURCE.json" : "SOURCE.json");
  const mappingStat = await lstat(mappingPath);
  if (!mappingStat.isFile() || mappingStat.isSymbolicLink() || mappingStat.size > 32_000) throw Error("Invalid candidate source mapping");
  const mapping = await readFile(mappingPath);
  if (JSON.stringify(JSON.parse(mapping)) !== JSON.stringify(pin)) throw Error("Candidate source mapping does not match reviewed pin");
  const files = new Map([["phonemizer-source/SOURCE.json", mapping]]);
  for (const [key, target] of [["binary", "phonemizer/phonemizer.js"], ["sourceArchive", "phonemizer-source/source.tar.gz"], ["notices", "phonemizer-source/NOTICES.txt"]]) {
    const item = pin[key];
    files.set(target, await regularBytes(join(directory, staged ? target : item.path), item));
  }
  return files;
}

async function writeFiles(output, files) {
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes, { flag: "wx", mode: 0o600 });
  }
}

export async function stageCandidate(directory, output) {
  output = await externalOutput(output);
  const files = await candidateFiles(directory);
  // No overwrite of an existing handoff; reuse only when every pinned byte matches.
  for (const [path, bytes] of files) {
    const target = join(output, path);
    try { await regularBytes(target, describe(bytes)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
  }
}

const rootFiles = ["AGENTS.md", "LICENSE", "README.md", "THIRD_PARTY.md", "package.json", "package-lock.json", "tsconfig.json", ".gitattributes", ".gitignore"];
const sourceDirectories = ["src", "scripts", "test", "docs", ".github"];
const forbidden = /(^|[/._-])(credentials?|secrets?|tokens?|auth|id_rsa|id_ed25519)([/._-]|$)|(^|\/)\.env(?:\.|$)/i;
const sourceExtension = /\.(?:ts|mjs|json|md|txt|py|c|h|ya?ml)$|(?:^|\/)[A-Z0-9_-]*(?:LICENSE|COPYING)(?:\.[A-Z0-9_-]+)?$/;

/** Exact working-tree bytes, not HEAD: no .git, node_modules, dist or implicit glob upload. */
export async function applicationSources(root = packageRoot) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("Source root must not be a symlink");
  const files = new Map();
  async function visit(path, explicit = false) {
    if (forbidden.test(path) || path.split("/").some(part => ["node_modules", ".git", "__pycache__"].includes(part))) throw Error(`Forbidden source path: ${path}`);
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw Error(`Source symlinks are not allowed: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) await visit(`${path}/${name}`);
    } else {
      if (!stat.isFile() || stat.size > 4_000_000 || (!explicit && !sourceExtension.test(path))) throw Error(`Not an allowed source file: ${path}`);
      files.set(path, await readFile(join(root, path)));
    }
  }
  for (const path of rootFiles) await visit(path, true);
  for (const path of sourceDirectories) await visit(path);
  return files;
}

export function dependencyInventory(sourceFiles) {
  const lock = JSON.parse(sourceFiles.get("package-lock.json"));
  const selected = Object.entries(bundledLicenses).map(([name, reviewed]) => {
    const item = lock.packages[`node_modules/${name}`];
    if (!item || item.version !== reviewed.version || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity)) throw Error(`Unreviewed dependency pin: ${name}`);
    const url = new URL(item.resolved);
    if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search) throw Error("Untrusted dependency source URL");
    return { name, version: item.version, license: reviewed.license, url: item.resolved, integrity: item.integrity,
      archive: `${name.replaceAll("/", "-").replaceAll("@", "")}-${item.version}.tgz`,
      sourceCompleteness: "Unverified: upstream npm package may contain generated code; archive is not a certification of preferred/native source completeness" };
  });
  return { bundled: selected, allLockedPackages: lock.packages,
    remainingGates: ["Review preferred-source completeness of each bundled npm archive, including prebundled dependencies.",
      "Supply and verify exact ONNX native runtime source/build correspondence; notices and an npm archive alone do not establish it.",
      "Review host/peer boundary and any additional combined-work source obligations.",
      "Review user-facing legal notices/source access and exact source-delivery terms before conveyance.",
      "Verify model/voice provenance and retain source/attribution needed for actual distributed assets."] };
}

/** Optional public software acquisition, never weights or an inference service. */
export async function acquireDependencyArchives(inventory, directory, download = false) {
  directory = await externalOutput(directory);
  await mkdir(directory, { recursive: true });
  for (const item of inventory.bundled) {
    const target = join(directory, item.archive);
    let bytes;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000_000) throw Error("Invalid dependency archive file");
      bytes = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!download) throw Error(`Missing dependency source archive: ${item.archive}; use --download-dependencies explicitly`);
      const response = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw Error(`Dependency archive unavailable: ${item.name}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 128_000_000) throw Error("Dependency archive exceeds bound");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== item.integrity) throw Error(`Dependency source integrity mismatch: ${item.name}`);
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
}

/** Assemble source evidence independently of weights, or include a verified import pack.
 * No imported manifest can redefine executable pins. This is not a legal-clearance gate.
 */
export async function assembleTtsDistribution({ output, candidate, input, dependencyArchives, downloadDependencies = false }) {
  output = await externalOutput(output);
  try { await lstat(output); throw Error("Distribution output must not already exist"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const engine = await candidateFiles(candidate);
  const sourceFiles = await applicationSources();
  const dependencies = dependencyInventory(sourceFiles);
  await acquireDependencyArchives(dependencies, dependencyArchives, downloadDependencies);
  const manifest = await speechManifest("tts");
  if (manifest.find(item => item.path === "phonemizer/phonemizer.js").sha256 !== sha256(engine.get("phonemizer/phonemizer.js"))) throw Error("Production/candidate mismatch");
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".tts-source-"));
  try {
    await writeFiles(temporary, engine);
    await writeFiles(join(temporary, "application"), sourceFiles);
    await copySpeechNotices(join(temporary, "notices"), "tts");
    await writeFile(join(temporary, "notices/BUNDLED-NOTICES.txt"), await bundleNoticeText(packageRoot));
    for (const item of dependencies.bundled) {
      const bytes = await readFile(join(dependencyArchives, item.archive));
      if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== item.integrity) throw Error("Dependency changed during assembly");
      await writeFiles(join(temporary, "dependencies"), new Map([[item.archive, bytes]]));
      item.artifact = describe(bytes);
    }
    await writeFile(join(temporary, "DEPENDENCIES.json"), JSON.stringify(dependencies, null, 2) + "\n");
    let pack;
    if (input) {
      await candidateFiles(input, true);
      const card = speechPack("tts").files.find(item => item.path === "README.md");
      await writeFiles(join(temporary, "notices"), new Map([["KOKORO-MODEL-CARD.md",
        await regularBytes(join(input, "models", speechPack("tts").model, card.path), card)]]));
      await exportSpeechPack(input, join(temporary, "english-tts.pivoice"), manifest, "tts");
      pack = { path: "english-tts.pivoice", ...describe(await readFile(join(temporary, "english-tts.pivoice"))) };
    }
    // Refuse a changing worktree rather than imply a coherent source snapshot.
    const after = await applicationSources();
    if (after.size !== sourceFiles.size || [...sourceFiles].some(([path, bytes]) => !bytes.equals(after.get(path) ?? Buffer.alloc(0)))) throw Error("Application source changed during assembly; retry explicitly");
    const noticePaths = ["ort/LICENSE", "ort/ThirdPartyNotices.txt", "TRANSFORMERS-LICENSE", "speech-pack-provenance.json",
      "KOKORO-JS-LICENSE", "ESPEAK-NG-COPYING", "TTS-NOTICE.txt", "PHONEMIZER-LICENSE", "PHONEMIZER-SOURCE.json",
      "TTS-QUALIFICATION.md", "BUNDLED-NOTICES.txt", ...(pack ? ["KOKORO-MODEL-CARD.md"] : [])];
    const notices = Object.fromEntries(await Promise.all(noticePaths.map(async path =>
      [path, describe(await readFile(join(temporary, "notices", path)))])));
    const record = {
      schema: 1, status: "review-required", releaseApproved: false, packIncluded: Boolean(pack), ...(pack ? { pack } : {}),
      notices,
      producerBoundary: "Repository-owned production and candidate pins; exact uncommitted application bytes; lock-integrity-verified npm archives",
      consumerBoundary: "Browser reads only compiled manifest and PIVOTTS1 bytes. It does not interpret this source inventory or treat import as license clearance.",
      engine: Object.fromEntries([...engine].map(([path, bytes]) => [path, describe(bytes)])),
      application: Object.fromEntries([...sourceFiles].map(([path, bytes]) => [path, describe(bytes)])),
      dependencyInventory: describe(await readFile(join(temporary, "DEPENDENCIES.json"))),
      remainingGates: dependencies.remainingGates,
      buildInstructions: "application/README.md and scripts/build.mjs; npm ci --ignore-scripts then npm run verify with Node 24+. Native recipe is inside phonemizer-source/source.tar.gz. Original per-file licenses remain; linked engine obligations are GPL-3.0-or-later. Review complete combined-source delivery and legal notices before conveyance."
    };
    await writeFile(join(temporary, "DISTRIBUTION.json"), JSON.stringify(record, null, 2) + "\n");
    await writeFile(join(temporary, "README.txt"), "REVIEW REQUIRED — NOT RELEASE APPROVAL\nKeep this directory together. Engine source, exact working-tree application source, dependency package archives and notices accompany the executable candidate. Npm archives may contain generated code and do not establish complete preferred/native corresponding source. See DISTRIBUTION.json / DEPENDENCIES.json for remaining gates. No model pack is included unless packIncluded is true. Never convey a lone .pivoice as an approved distribution.\n");
    await rename(temporary, output);
    return record;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: "string" }, candidate: { type: "string" }, input: { type: "string" },
    "dependency-archives": { type: "string" }, "download-dependencies": { type: "boolean", default: false } } });
  const record = await assembleTtsDistribution({ output: values.output, candidate: values.candidate, input: values.input,
    dependencyArchives: values["dependency-archives"], downloadDependencies: values["download-dependencies"] });
  console.log(`Assembled review-required TTS distribution at ${values.output}; packIncluded=${record.packIncluded}. Not release approval.`);
}
