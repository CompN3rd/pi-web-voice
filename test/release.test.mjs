import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkRelease } from "../scripts/check-release.mjs";

const pkg = { name: "@compn3rd/pi-web-voice", version: "1.2.3", private: false, repository: { url: "git+https://github.com/CompN3rd/pi-web-voice.git" } };
const lock = { name: pkg.name, version: pkg.version, packages: { "": { version: pkg.version } } };
const ref = "refs/tags/v1.2.3";
test("release accepts only explicit clearance and matching stable identity", () => {
  assert.doesNotThrow(() => checkRelease(pkg, lock, ref));
  for (const privateValue of [true, undefined, "false", 0]) {
    assert.throws(() => checkRelease({ ...pkg, private: privateValue }, lock, ref), /Release blocked/);
  }
  for (const badRef of [undefined, "refs/heads/main", "refs/tags/v1.2.4", "refs/tags/v1.2.3-beta"]) {
    assert.throws(() => checkRelease(pkg, lock, badRef), /matching stable/);
  }
  assert.throws(() => checkRelease({ ...pkg, name: "other" }, lock, ref), /package name/);
  assert.throws(() => checkRelease({ ...pkg, repository: undefined }, lock, ref), /repository metadata/);
  assert.throws(() => checkRelease(pkg, { ...lock, version: "1.2.4" }, ref), /lock mismatch/);
  assert.throws(() => checkRelease(pkg, { ...lock, packages: {} }, ref), /lock mismatch/);
});
test("prototype remains blocked from publication", () => {
  const actual = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const actualLock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(actual.private, true, "remove this prototype-only assertion only with release clearance");
  assert.throws(() => checkRelease(actual, actualLock, `refs/tags/v${actual.version}`), /Release blocked/);
});
