import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { acquireSourceArchives, dependencySources, sourceArchiveItems } from "../scripts/dependency-sources.mjs";
import { bundledLicenses } from "../scripts/bundle-notices.mjs";
import { sha256 } from "../scripts/speech-assets.mjs";

test("dependency-sources: offline verifier rejects oversized archives before reading and hashes in bounded chunks", () => {
  execFileSync("python3", ["-B", "-c", `
import hashlib, importlib.util, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("verifier", "scripts/verify-dependency-sources.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
with tempfile.TemporaryDirectory() as root:
    path = Path(root) / "archive.tgz"
    with path.open("wb") as stream:
        stream.truncate(128_000_001)
    with patch.object(Path, "open", side_effect=AssertionError("oversized file must not be read")):
        for kwargs in [{}, {"expected_size": 8}]:
            try:
                v.archive_digest(path, "sha256", **kwargs)
            except ValueError:
                pass
            else:
                raise AssertionError("accepted oversized archive")
    data = b"a" * (2 * 1024 * 1024 + 7)
    path.write_bytes(data)
    with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read forbidden")):
        assert v.archive_digest(path, "sha256", expected_size=len(data)) == hashlib.sha256(data).digest()
        assert v.archive_digest(path, "sha512") == hashlib.sha512(data).digest()
    link = Path(root) / "link.tgz"
    link.symlink_to(path)
    try:
        v.archive_digest(link, "sha256")
    except ValueError:
        pass
    else:
        raise AssertionError("accepted symlink")
`], { stdio: "pipe" });
});

const bytes = Buffer.from("upstream fixture, not a real source archive");
const item = { archive: "source.tar.gz", url: "https://codeload.github.com/example/source/tar.gz/" + "a".repeat(40), bytes: bytes.length, sha256: sha256(bytes) };
const inventory = { archives: [item], embeddedPackages: [] };
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "voice-upstream-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("dependency-sources: immutable archives cover actual direct packages and separately identified prebundles", async () => {
  const sources = await dependencySources();
  assert.deepEqual(sources.packages.map(item => item.name).sort(), Object.keys(bundledLicenses).sort());
  assert.equal(sources.archives.length, 7);
  for (const archive of sources.archives) {
    assert.match(archive.revision, /^[a-f0-9]{40}$/);
    assert.equal(archive.url, `${archive.repository.replace("https://github.com", "https://codeload.github.com")}/tar.gz/${archive.revision}`);
    assert.ok(Object.keys(archive.evidenceFiles).length >= 5, "source/build evidence, not metadata alone");
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(sources.embeddedPackages[0].version, "0.5.3");
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.notEqual(sources.embeddedPackages[0].version, lock.packages["node_modules/@huggingface/jinja"].version);
  assert.equal(sourceArchiveItems(sources).length, 8);
  assert.ok(sources.onnxNative.declaredDependencies.length > 30);
  assert.equal(sources.onnxNative.gitSubmodules.length, 3);
  assert.match(sources.onnxNative.status, /not a WASM link inventory/);
  assert.ok(sources.remainingGates.some(gate => gate.includes("native binary/source/build correspondence")));
});

test("dependency-sources: recorded bundle inputs and embedded modules match installed production entrypoints", async () => {
  const sources = await dependencySources();
  const inputs = new Set();
  for (const [entry, platform] of [["src/browser/index.ts", "browser"], ["src/browser/tts-worker.ts", "browser"], ["src/browser/recognition-worker.ts", "browser"], ["src/server.ts", "node"]]) {
    const result = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: "esm", platform, logLevel: "silent" });
    for (const input of Object.keys(result.metafile.inputs)) if (input.includes("node_modules/")) inputs.add(input);
  }
  assert.deepEqual([...inputs].sort(), sources.bundledInputs);
  const map = JSON.parse(await readFile("node_modules/@huggingface/transformers/dist/transformers.web.js.map", "utf8"));
  const embedded = map.sources.flatMap((path, index) => path.includes("/node_modules/") ? [{ path, content: map.sourcesContent[index] }] : []);
  assert.equal(embedded.length, 1);
  assert.ok(embedded[0].path.endsWith("/@huggingface/jinja/dist/index.js"));
  assert.equal(sha256(Buffer.from(embedded[0].content)), sources.embeddedPackages[0].embeddedSource.sha256);
});

test("dependency-sources: cached archives reject corruption and symlinks; no implicit download", async () => fixture(async root => {
  await assert.rejects(acquireSourceArchives(inventory, root), /--download-sources explicitly/);
  await writeFile(join(root, item.archive), bytes);
  await acquireSourceArchives(inventory, root);
  await writeFile(join(root, item.archive), Buffer.alloc(bytes.length));
  await assert.rejects(acquireSourceArchives(inventory, root, true), /integrity mismatch/);
  await rm(join(root, item.archive));
  await writeFile(join(root, "target"), bytes);
  await symlink(join(root, "target"), join(root, item.archive));
  await assert.rejects(acquireSourceArchives(inventory, root), /symlinks|length\/type mismatch/);
}));

test("dependency-sources: explicit acquisition bounds bytes and verifies before caching", async () => fixture(async root => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response(bytes); };
    await acquireSourceArchives(inventory, root, true);
    assert.deepEqual(await readFile(join(root, item.archive)), bytes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.redirect, "error");
    await acquireSourceArchives(inventory, root, true);
    assert.equal(calls.length, 1, "cached success never downloads");
    await rm(join(root, item.archive));
    globalThis.fetch = async () => new Response(Buffer.alloc(bytes.length));
    await assert.rejects(acquireSourceArchives(inventory, root, true), /integrity mismatch/);
    globalThis.fetch = async () => new Response(Buffer.alloc(bytes.length + 1));
    await assert.rejects(acquireSourceArchives(inventory, root, true), /exceeds pinned size/);
    assert.deepEqual(await readdir(root), []);
  } finally { globalThis.fetch = original; }
}));

test("dependency-sources: source acquisition refuses path traversal and non-public origins", async () => fixture(async root => {
  for (const override of [{ archive: "../source.tar.gz" }, { url: "http://codeload.github.com/source" }, { url: "https://example.com/source" }, { url: "https://user@codeload.github.com/source" }, { bytes: 300_000_001 }]) {
    await assert.rejects(acquireSourceArchives({ archives: [{ ...item, ...override }], embeddedPackages: [] }, root, true), /Invalid upstream|Untrusted upstream/);
  }
  assert.deepEqual(await readdir(root), []);
}));
