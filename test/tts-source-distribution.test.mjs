import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireDependencyArchives, applicationSources, candidateFiles, dependencyInventory } from "../scripts/tts-source-distribution.mjs";
import { exportSpeechPack } from "../scripts/export-speech-pack.mjs";
import { sha256, packageRoot } from "../scripts/speech-assets.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tts-source-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function snapshotFixture(root) {
  const source = await applicationSources();
  for (const [path, bytes] of source) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
}

test("tts-source-distribution: allowlist preserves uncommitted bytes without reading unrelated roots", async () => fixture(async root => {
  await snapshotFixture(root);
  await mkdir(join(root, ".git")); await writeFile(join(root, ".git/config"), "not source");
  await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules/private"), "not source");
  const changed = Buffer.from("// exact uncommitted source\r\nexport const changed = true;\r\n");
  await writeFile(join(root, "src/uncommitted.ts"), changed);
  const files = await applicationSources(root);
  assert.deepEqual(files.get("src/uncommitted.ts"), changed);
  assert.ok(![...files.keys()].some(path => /^(\.git\/|node_modules\/|dist\/)/.test(path)));
  const inventory = dependencyInventory(files);
  assert.equal(inventory.bundled.length, 8);
  assert.ok(inventory.bundled.every(item => item.integrity.startsWith("sha512-") && item.sourceCompleteness.startsWith("Unverified")));
  assert.ok(inventory.remainingGates.some(item => item.includes("ONNX native")));
}));

test("tts-source-distribution: source snapshot rejects credential names, payloads and symlinks", async () => fixture(async root => {
  await snapshotFixture(root);
  for (const name of [".env", "credentials.json", "auth.json", "model.onnx"]) {
    await writeFile(join(root, "src", name), "must not be copied");
    await assert.rejects(applicationSources(root), /Forbidden|allowed source/);
    await rm(join(root, "src", name));
  }
  await symlink(packageRoot, join(root, "src/linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(applicationSources(root), /symlinks/);
}));

test("tts-source-distribution: dependency archives must match lock integrity; no implicit acquisition", async () => fixture(async root => {
  const bytes = Buffer.from("fixture source archive, not executable");
  const item = { name: "fixture", archive: "fixture.tgz", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  await assert.rejects(acquireDependencyArchives({ bundled: [item] }, root), /Missing dependency source/);
  await writeFile(join(root, item.archive), bytes);
  await acquireDependencyArchives({ bundled: [item] }, root);
  await writeFile(join(root, item.archive), "corrupt");
  await assert.rejects(acquireDependencyArchives({ bundled: [item] }, root), /integrity mismatch/);
}));

test("tts-source-distribution: producer mapping cannot select alternate engine bytes or sources", async () => fixture(async root => {
  const record = JSON.parse(await readFile("scripts/phonemizer/candidate.json", "utf8"));
  record.binary.sha256 = "0".repeat(64);
  await writeFile(join(root, "SOURCE.json"), JSON.stringify(record));
  await assert.rejects(candidateFiles(root), /does not match reviewed pin/);
  assert.deepEqual(await readdir(root), ["SOURCE.json"]);
}));

test("tts-source-distribution: raw TTS CLI export and download are blocked before writing; recognition unchanged", async () => fixture(async root => {
  for (const [script, args, message] of [
    ["provision-speech-pack.mjs", ["--pack", "tts", "--download", "--output", join(root, "pack")], /TTS download unavailable/],
    ["export-speech-pack.mjs", ["--pack", "tts", "--input", root, "--output", join(root, "pack.pivoice")], /source-aware assembly/],
  ]) {
    const result = spawnSync(process.execPath, [`scripts/${script}`, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /Downloading/); assert.deepEqual(await readdir(root), []);
  }
}));

test("tts-source-distribution: low-level pack producer uses exact supplied bytes; source assembly never trusts imported metadata", async () => fixture(async root => {
  const input = join(root, "input"); await mkdir(input);
  const model = Buffer.from("fake model bytes for format test only");
  await writeFile(join(input, "model.bin"), model);
  await writeFile(join(input, "speech-assets.json"), JSON.stringify([{ path: "untrusted" }]));
  const assets = [{ path: "model.bin", bytes: model.length, sha256: sha256(model) }];
  const output = join(root, "fixture.pivoice");
  await exportSpeechPack(input, output, assets, "tts");
  assert.deepEqual(await readFile(output), Buffer.concat([Buffer.from("PIVOTTS1"), model]));
  await writeFile(join(input, "model.bin"), "corrupt");
  await assert.rejects(exportSpeechPack(input, output, assets, "tts"), /length\/type/);
}));
