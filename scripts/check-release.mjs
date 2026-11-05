import fs from "node:fs";
import { pathToFileURL } from "node:url";

// This is a fail-closed release gate, not evidence of model/device/license acceptance.
export function checkRelease(pkg, lock, ref) {
  if (pkg.private !== false) throw new Error("Release blocked: explicitly set private:false only after acceptance, licensing and owner approval");
  if (pkg.name !== "@compn3rd/pi-web-voice") throw new Error("Unexpected package name");
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || ref !== `refs/tags/v${pkg.version}`) throw new Error("A matching stable version tag is required");
  if (lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) throw new Error("Package/lock mismatch");
  if (pkg.repository?.url !== "git+https://github.com/CompN3rd/pi-web-voice.git") throw new Error("Confirm public repository metadata before release");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkRelease(JSON.parse(fs.readFileSync("package.json", "utf8")), JSON.parse(fs.readFileSync("package-lock.json", "utf8")), process.env.GITHUB_REF);
}
