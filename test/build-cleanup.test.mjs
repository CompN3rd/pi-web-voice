import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkBrowserDirectory } from "../scripts/check-package-size.mjs";
import { pack, packageRoot } from "../scripts/speech-assets.mjs";

function build(...args) {
  const npm = process.env.npm_execpath;
  const result = spawnSync(npm ? process.execPath : "npm", [...(npm ? [npm] : []), "run", "build", "--", ...args],
    { encoding: "utf8", shell: !npm && process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
async function generatedFiles(directory = "dist") {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await generatedFiles(path));
    else files[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return files;
}

// Keep all tests that mutate the worktree build output in this file. Node runs
// test files concurrently, but these top-level tests run sequentially.
test("build: full output is identical before and after a speech-only harness build", async () => {
  build();
  const before = await generatedFiles();
  assert.ok(!Object.hasOwn(before, "dist/browser/local-recognizer.js"));
  build("--speech-only");
  assert.ok((await readFile("dist/browser/local-recognizer.js")).length > 0);
  build();
  assert.deepEqual(await generatedFiles(), before);
});

test("build removes only obsolete generated speech trees and preserves notices", async () => {
  const speech = join(packageRoot, "dist/browser/speech");
  await mkdir(join(speech, "models"), { recursive: true });
  await mkdir(join(speech, "ort"), { recursive: true });
  await writeFile(join(speech, "models/obsolete-test.onnx"), "obsolete model");
  await writeFile(join(speech, "ort/obsolete-test.wasm"), "obsolete runtime");
  build();
  await assert.rejects(readFile(join(speech, "models/obsolete-test.onnx")), { code: "ENOENT" });
  await assert.rejects(readFile(join(speech, "ort/obsolete-test.wasm")), { code: "ENOENT" });
  assert.ok((await readFile(join(speech, "ort/LICENSE"))).length > 0);
  assert.deepEqual(JSON.parse(await readFile(join(speech, "speech-pack-provenance.json"), "utf8")), pack);
  await checkBrowserDirectory(join(packageRoot, "dist/browser"));
});
