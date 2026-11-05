import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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

test("build: full output is identical before and after a speech-only harness build", async () => {
  build();
  const before = await generatedFiles();
  assert.ok(!Object.hasOwn(before, "dist/browser/local-recognizer.js"));
  build("--speech-only");
  assert.ok((await readFile("dist/browser/local-recognizer.js")).length > 0);
  build();
  assert.deepEqual(await generatedFiles(), before);
});
