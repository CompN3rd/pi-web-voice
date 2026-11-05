import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBrowserDirectory, checkInventory, MAX_PACKAGE_BYTES } from "../scripts/check-package-size.mjs";
import { externalOutput, pack, packageRoot, sha256, speechManifest, speechPack, speechCacheName, copySpeechNotices, validAsset } from "../scripts/speech-assets.mjs";
import { exportSpeechPack } from "../scripts/export-speech-pack.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-voice-assets-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("speechManifest pins asset hashes, lengths, order and explicit download URLs", async () => {
  const assets = await speechManifest();
  assert.equal(assets.length, pack.files.length + 1);
  assert.equal(assets.some(asset => asset.path.endsWith("README.md")), false);
  assert.deepEqual(assets.slice(0, -2), pack.files.filter(file => file.path !== "README.md").map(file => ({
    ...file, path: `models/${pack.model}/${file.path}`,
    downloadUrl: `https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/${file.path}`,
  })));
  assert.deepEqual(assets.slice(-2).map(({ bytes, sha256 }) => ({ bytes, sha256 })), [
    { bytes: 44484, sha256: "08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9" },
    { bytes: 21596019, sha256: "c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39" },
  ]);
  for (const asset of assets.filter(asset => asset.path.startsWith("ort/"))) {
    assert.equal(validAsset(await readFile(join(packageRoot, "node_modules/onnxruntime-web/dist", asset.path.slice(4))), asset), true);
    assert.equal(asset.downloadUrl, `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/${asset.path.slice(4)}`);
  }
  const bytes = Buffer.from("verified");
  const asset = { bytes: bytes.length, sha256: sha256(bytes) };
  assert.equal(validAsset(bytes, asset), true);
  assert.equal(validAsset(Buffer.from("corrupt!"), asset), false);
  assert.equal(validAsset(Buffer.from("verified extra"), asset), false);
});

test("TTS inventory is independently pinned and does not alter the default recognition manifest", async () => {
  const recognition = await speechManifest();
  const assets = await speechManifest("tts");
  assert.deepEqual(await speechManifest("recognition"), recognition);
  assert.equal(speechCacheName("recognition", recognition), `pi-voice-speech-${sha256(JSON.stringify(recognition)).slice(0, 24)}`);
  assert.notEqual(speechCacheName("tts", recognition), speechCacheName("recognition", recognition));
  assert.notEqual(speechCacheName("tts", assets), speechCacheName("tts", recognition));
  assert.equal(speechCacheName("recognition", recognition), "pi-voice-speech-4d8396d1642c004c88323bf2");
  assert.equal(speechCacheName("tts", assets), "pi-voice-tts-509a9b40952d3a5adb703aec");
  assert.notEqual(speechCacheName("tts", assets), "pi-voice-tts-e12b51622742c29ef163e9e9", "retired published pack cache is never reused");
  assert.equal(speechPack().model, "onnx-community/whisper-tiny.en");
  assert.equal(speechPack("tts").voice, "af_heart");
  assert.equal(assets.length, 8);
  assert.equal(assets.reduce((total, asset) => total + asset.bytes, 0), 116_019_342);
  assert.equal(assets[3].bytes, 92_361_116);
  assert.equal(assets[3].sha256, "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478");
  assert.equal(assets[4].path.endsWith("voices/af_heart.bin"), true);
  assert.equal(assets[5].path, "phonemizer/phonemizer.js");
  assert.equal(assets[5].downloadUrl, undefined);
  assert.deepEqual(assets.slice(-2), recognition.slice(-2).map(({ downloadUrl, ...asset }) => asset));
  for (const asset of assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    assert.equal(asset.downloadUrl, undefined);
  }
  await assert.rejects(speechManifest("untrusted"), /Unknown speech pack kind/);
});

test("TTS CLI selection never implicitly downloads and rejects unknown packs before writing", async () => fixture(async root => {
  for (const script of ["provision-speech-pack.mjs", "export-speech-pack.mjs"]) {
    const args = script.startsWith("provision") ? ["--output", join(root, "pack")] : ["--input", root, "--output", join(root, "tts.pivoice")];
    for (const kind of ["tts", "unknown"]) {
      const result = spawnSync(process.execPath, [`scripts/${script}`, ...args, "--pack", kind], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, kind === "unknown" ? /Unknown speech pack kind/ : /Missing or invalid|ENOENT|requires --candidate|source-aware assembly/);
      assert.doesNotMatch(result.stdout, /Downloading/);
      assert.deepEqual(await readdir(root), []);
    }
  }
}));

test("TTS external notices retain the original MIT wrapper and GPL combined-work qualification warning", async () => fixture(async root => {
  await copySpeechNotices(root, "tts");
  assert.deepEqual(JSON.parse(await readFile(join(root, "speech-pack-provenance.json"), "utf8")), speechPack("tts"));
  assert.equal(await readFile(join(root, "PHONEMIZER-LICENSE"), "utf8"), await readFile("scripts/phonemizer/LICENSE", "utf8"));
  assert.match(await readFile(join(root, "TTS-QUALIFICATION.md"), "utf8"), /corresponding-source/);
  assert.ok((await readFile(join(root, "ort/LICENSE"))).length > 0);
}));

test("TTS provisioning requires source-mapped replacement before reusing any model bytes", async () => fixture(async root => {
  const source = join(root, "source");
  const output = join(root, "output");
  await mkdir(source);
  const result = spawnSync(process.execPath, ["scripts/provision-speech-pack.mjs", "--pack", "tts", "--output", output, "--from-pack", source], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --candidate/);
  assert.doesNotMatch(result.stdout, /Downloading/);
  assert.deepEqual(await readdir(root), ["source"]);
}));

test("externalOutput rejects missing/relative/in-repo paths and symlink containment", async () => fixture(async temp => {
  const root = join(temp, "repo");
  await mkdir(root);
  await assert.rejects(externalOutput(undefined, root), /absolute/);
  await assert.rejects(externalOutput("relative", root), /absolute/);
  await assert.rejects(externalOutput(root, root), /outside/);
  await assert.rejects(externalOutput(join(root, "new", "pack"), root), /outside/);
  const alias = join(temp, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(externalOutput(join(alias, "new", "pack"), root), /outside/);
  const output = join(temp, "external");
  assert.equal(await externalOutput(output, root), output);
  await mkdir(output);
  await symlink(root, join(output, "models"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(externalOutput(output, root), /symlinks/);
}));

test("provision command requires external output and never implicitly downloads missing/corrupt files", async () => fixture(async temp => {
  for (const args of [[], ["--output", "relative"], ["--output", packageRoot]]) {
    const result = spawnSync(process.execPath, ["scripts/provision-speech-pack.mjs", ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absolute|outside/);
  }
  const target = join(temp, "pack", "models", pack.model);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "config.json"), "corrupt");
  const result = spawnSync(process.execPath, ["scripts/provision-speech-pack.mjs", "--output", join(temp, "pack")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing or invalid config.json/);
  assert.doesNotMatch(result.stdout, /Downloading/);
  assert.equal(await readFile(join(target, "config.json"), "utf8"), "corrupt");
}));

test("package gate counts total bytes, accepts exact ceiling, rejects speech payloads regardless of size", () => {
  assert.equal(checkInventory([{ path: "index.js", size: MAX_PACKAGE_BYTES }]), MAX_PACKAGE_BYTES);
  assert.throws(() => checkInventory([{ path: "a.js", size: MAX_PACKAGE_BYTES }, { path: "b.txt", size: 1 }]), /exceeds/);
  for (const path of ["dist/browser/speech/models/config.json", "model.onnx", "runtime.wasm", "weights.bin", "english.pivoice", "ENGLISH.PIVOICE", "ort-wasm-simd-threaded.jsep.mjs", "phonemizer.js", "nested/phonemizer.cjs"]) {
    assert.throws(() => checkInventory([{ path, size: 1 }]), /external speech payload/);
  }
});

test("build browser gate rejects stale payloads and oversized generated directory", async () => fixture(async root => {
  await writeFile(join(root, "index.js"), "export {};");
  assert.equal(await checkBrowserDirectory(root), 10);
  await writeFile(join(root, "runtime.wasm"), "payload");
  await assert.rejects(checkBrowserDirectory(root), /external speech payload/);
  await rm(join(root, "runtime.wasm"));
  await writeFile(join(root, "too-large.js"), Buffer.alloc(MAX_PACKAGE_BYTES));
  await assert.rejects(checkBrowserDirectory(root), /exceeds/);
}));

test("package allowlist includes notices but excludes runtime/model directories", async () => {
  const metadata = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(metadata.files.includes("dist/browser/*.js"));
  assert.ok(metadata.files.includes("dist/browser/speech/ort/LICENSE"));
  assert.ok(metadata.files.includes("dist/browser/speech/speech-pack-provenance.json"));
  assert.equal(metadata.files.includes("dist"), false);
  for (const hook of ["install", "postinstall", "prepare", "prepack"]) assert.equal(metadata.scripts[hook], undefined);
  const worker = await readFile("src/browser/recognition-worker.ts", "utf8");
  assert.match(worker, /XMLHttpRequest is disabled/);
});

async function exportFixture(run) {
  await fixture(async root => {
    const input = join(root, "input");
    await mkdir(join(input, "models"), { recursive: true });
    const contents = [Buffer.from("first"), Buffer.alloc(130_001, 42)];
    const assets = contents.map((bytes, index) => ({ path: `models/${index}.bin`, bytes: bytes.length, sha256: sha256(bytes) }));
    for (let i = 0; i < assets.length; i++) await writeFile(join(input, assets[i].path), contents[i]);
    // Untrusted metadata and notices are not part of the binary import.
    await writeFile(join(input, "speech-assets.json"), '[{"path":"untrusted"}]');
    await writeFile(join(input, "LICENSE"), "separate notice");
    await run({ root, input, output: join(root, "english.pivoice"), assets, contents });
  });
}

test("exportSpeechPack writes exact PIVOICE1 header and sequential raw assets, replacing regular output atomically", async () => exportFixture(async ({ root, input, output, assets, contents }) => {
  await writeFile(output, "old file");
  const length = await exportSpeechPack(input, output, assets);
  const bytes = await readFile(output);
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "PIVOICE1");
  assert.equal(length, 8 + assets.reduce((total, asset) => total + asset.bytes, 0));
  assert.equal(bytes.length, length);
  assert.deepEqual(bytes, Buffer.concat([Buffer.from("PIVOICE1"), ...contents]));
  let offset = 8;
  for (const asset of assets) {
    assert.equal(validAsset(bytes.subarray(offset, offset + asset.bytes), asset), true);
    offset += asset.bytes;
  }
  assert.deepEqual((await readdir(root)).sort(), ["english.pivoice", "input"]);
}));

test("explicit TTS exports use PIVOTTS1 while preserving the default Whisper format", async () => exportFixture(async ({ input, output, assets, contents }) => {
  await exportSpeechPack(input, output, assets, "tts");
  assert.deepEqual(await readFile(output), Buffer.concat([Buffer.from("PIVOTTS1"), ...contents]));
  await assert.rejects(exportSpeechPack(input, output, assets, "unknown"), /Unknown speech pack kind/);
  assert.deepEqual(await readFile(output), Buffer.concat([Buffer.from("PIVOTTS1"), ...contents]));
  await exportSpeechPack(input, output, assets);
  assert.deepEqual(await readFile(output), Buffer.concat([Buffer.from("PIVOICE1"), ...contents]));
}));

test("exportSpeechPack rejects missing, short, oversized and corrupt sources without publishing or retaining temporary files", async () => {
  for (const mutation of ["missing", "short", "oversized", "corrupt"]) await exportFixture(async ({ root, input, output, assets, contents }) => {
    const path = join(input, assets[1].path);
    if (mutation === "missing") await rm(path);
    else if (mutation === "short") await writeFile(path, contents[1].subarray(1));
    else if (mutation === "oversized") await writeFile(path, Buffer.concat([contents[1], Buffer.from("extra")]));
    else await writeFile(path, Buffer.alloc(contents[1].length, 7));
    await writeFile(output, "preserve previous output");
    await assert.rejects(exportSpeechPack(input, output, assets), /ENOENT|length\/type|integrity/);
    assert.equal(await readFile(output, "utf8"), "preserve previous output");
    assert.deepEqual((await readdir(root)).sort(), ["english.pivoice", "input"]);
    await rm(output);
    await assert.rejects(exportSpeechPack(input, output, assets));
    assert.deepEqual(await readdir(root), ["input"]);
  });
});

test("exportSpeechPack rejects relative, internal, wrong-extension and symlink destinations", async () => exportFixture(async ({ root, input, output, assets }) => {
  for (const destination of [undefined, "relative.pivoice", join(packageRoot, "forbidden.pivoice"), join(root, "wrong.zip")]) {
    await assert.rejects(exportSpeechPack(input, destination, assets), /absolute|outside|pivoice/);
  }
  for (const source of [undefined, "relative", packageRoot]) await assert.rejects(exportSpeechPack(source, output, assets), /absolute|outside/);
  const directory = join(root, "directory.pivoice");
  await mkdir(directory);
  await assert.rejects(exportSpeechPack(input, directory, assets), /regular file/);
  const alias = join(root, "repo-alias");
  await symlink(packageRoot, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportSpeechPack(input, join(alias, "new", "bad.pivoice"), assets), /outside/);
  // Directory junctions exercise symlink refusal even on Windows without file-symlink privileges.
  await symlink(input, output, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportSpeechPack(input, output, assets), /symlink/);
  await rm(output);
  await symlink(join(root, "directory.pivoice"), join(input, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportSpeechPack(input, output, assets), /symlinks/);
}));

test("speech:export CLI requires explicit paths and has no download option or lifecycle hook", async () => fixture(async root => {
  const metadata = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(metadata.scripts["speech:export"], "node scripts/export-speech-pack.mjs");
  for (const args of [[], ["--download"], ["--input", root, "--output", join(root, "missing.pivoice")]]) {
    const result = spawnSync(process.execPath, ["scripts/export-speech-pack.mjs", ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absolute|Unknown option|ENOENT/);
    assert.doesNotMatch(result.stdout, /Downloading/);
  }
  assert.deepEqual(await readdir(root), []);
}));
