import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundledLicenses, bundlePackages, writeBundleNotices } from "../scripts/bundle-notices.mjs";

test("bundle inventory rejects unknown dependencies and handles nested/Windows paths", () => {
  assert.deepEqual(bundlePackages(["src/a.ts", "node_modules/lit/index.js", "node_modules/a/node_modules/lit/index.js", "node_modules\\lit-html\\lit-html.js"]), ["lit", "lit-html"]);
  assert.throws(() => bundlePackages(["node_modules/unreviewed/index.js"]), /Unreviewed bundled dependency/);
});

test("generated bundle notices retain complete license text for every reviewed package", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-notices-"));
  try {
    await mkdir(join(root, "dist"));
    await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
    await symlink(resolve("scripts"), join(root, "scripts"), "junction");
    await writeBundleNotices(root, Object.keys(bundledLicenses).map(name => `node_modules/${name}/index.js`));
    // A subsequent speech-only inventory must retain UI/server notices.
    await writeBundleNotices(root, ["node_modules/@huggingface/transformers/src/transformers.js"]);
    const result = await readFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const [name, item] of Object.entries(bundledLicenses)) {
      assert.ok(result.includes(`${name}@${item.version}`));
      assert.ok(result.includes(await readFile(item.file ?? `node_modules/${name}/LICENSE`, "utf8")));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nested installation metadata is checked rather than its top-level namesake", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-nested-notices-"));
  try {
    await mkdir(join(root, "dist"));
    await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
    await symlink(resolve("scripts"), join(root, "scripts"), "junction");
    const nested = "vendor/node_modules/onnxruntime-common";
    await mkdir(join(root, nested), { recursive: true });
    const actual = { name: "onnxruntime-common", version: "1.22.0-dev.20250409-89f8206ba4", license: "MIT" };
    await writeFile(join(root, nested, "package.json"), JSON.stringify(actual));
    await assert.rejects(writeBundleNotices(root, [`${nested}/index.js`]), /Bundled license\/version changed/);
    await writeFile(join(root, nested, "package.json"), JSON.stringify({ ...actual, version: "1.21.0", license: "GPL-3.0" }));
    await assert.rejects(writeBundleNotices(root, [`${nested}/index.js`]), /Bundled license\/version changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pinned upstream ONNX third-party notice is unmodified and shipped with both runtimes", async () => {
  const bytes = await readFile("scripts/speech-licenses/ONNXRUNTIME-ThirdPartyNotices.txt");
  assert.equal(bytes.length, 326866);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  for (const path of ["dist/THIRD_PARTY_NOTICES.txt", "THIRD_PARTY.md", "dist/browser/speech/ort/ThirdPartyNotices.txt", "dist/browser/tts/ort/ThirdPartyNotices.txt"]) assert.ok(pkg.files.includes(path));
});
