import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBrowserDirectory, checkInventory, MAX_PACKAGE_BYTES } from "../scripts/check-package-size.mjs";
import { externalOutput, pack, packageRoot, sha256, speechManifest, validAsset } from "../scripts/speech-assets.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-voice-assets-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("speechManifest hashes matching runtime without copying assets into browser output", async () => {
  const assets = await speechManifest();
  assert.equal(assets.length, pack.files.length + 1);
  assert.equal(assets.some(asset => asset.path.endsWith("README.md")), false);
  for (const asset of assets.filter(asset => asset.path.startsWith("ort/"))) {
    assert.equal(validAsset(await readFile(join(packageRoot, "node_modules/onnxruntime-web/dist", asset.path.slice(4))), asset), true);
  }
  const bytes = Buffer.from("verified");
  const asset = { bytes: bytes.length, sha256: sha256(bytes) };
  assert.equal(validAsset(bytes, asset), true);
  assert.equal(validAsset(Buffer.from("corrupt!"), asset), false);
  assert.equal(validAsset(Buffer.from("verified extra"), asset), false);
});

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
  for (const path of ["dist/browser/speech/models/config.json", "model.onnx", "runtime.wasm", "weights.bin", "ort-wasm-simd-threaded.jsep.mjs"]) {
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

test("build removes only obsolete generated speech trees and preserves notices", async () => {
  const speech = join(packageRoot, "dist/browser/speech");
  await mkdir(join(speech, "models"), { recursive: true });
  await mkdir(join(speech, "ort"), { recursive: true });
  await writeFile(join(speech, "models/obsolete-test.onnx"), "obsolete model");
  await writeFile(join(speech, "ort/obsolete-test.wasm"), "obsolete runtime");
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot, encoding: "utf8" });
  await assert.rejects(readFile(join(speech, "models/obsolete-test.onnx")), { code: "ENOENT" });
  await assert.rejects(readFile(join(speech, "ort/obsolete-test.wasm")), { code: "ENOENT" });
  assert.ok((await readFile(join(speech, "ort/LICENSE"))).length > 0);
  assert.deepEqual(JSON.parse(await readFile(join(speech, "speech-pack-provenance.json"), "utf8")), pack);
  await checkBrowserDirectory(join(packageRoot, "dist/browser"));
});

test("package allowlist includes notices but excludes runtime/model directories", async () => {
  const metadata = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(metadata.files.includes("dist/browser/*.js"));
  assert.ok(metadata.files.includes("dist/browser/speech/ort/LICENSE"));
  assert.ok(metadata.files.includes("dist/browser/speech/speech-pack-provenance.json"));
  assert.equal(metadata.files.includes("dist"), false);
  for (const hook of ["install", "postinstall", "prepare", "prepack"]) assert.equal(metadata.scripts[hook], undefined);
  const worker = await readFile("src/browser/recognition-worker.ts", "utf8");
  assert.match(worker, /new URL\("\/pi-voice-speech\/", import.meta.url\)/);
  assert.match(worker, /XMLHttpRequest is disabled/);
});
