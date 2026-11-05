import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// Reviewed bundle inputs, not the entire development dependency tree.
export const bundledLicenses = {
  "@lit/reactive-element": { version: "2.1.2", license: "BSD-3-Clause" },
  "lit-html": { version: "3.3.3", license: "BSD-3-Clause" },
  "lit-element": { version: "4.2.2", license: "BSD-3-Clause" },
  lit: { version: "3.3.3", license: "BSD-3-Clause" },
  "@huggingface/transformers": { version: "3.8.1", license: "Apache-2.0" },
  "onnxruntime-common": { version: "1.21.0", license: "MIT", file: "scripts/speech-licenses/ONNXRUNTIME-LICENSE" },
  "onnxruntime-web": { version: "1.22.0-dev.20250409-89f8206ba4", license: "MIT", file: "scripts/speech-licenses/ONNXRUNTIME-LICENSE" },
  "@jmfederico/pi-web": { version: "1.202610.3", license: "MIT" },
};

export function bundleInstallations(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    const path = input.replaceAll("\\", "/");
    if (!path.includes("node_modules/")) continue;
    const tail = path.split("node_modules/").at(-1);
    const name = tail.split("/").slice(0, tail.startsWith("@") ? 2 : 1).join("/");
    if (!Object.hasOwn(bundledLicenses, name)) throw new Error(`Unreviewed bundled dependency: ${name}`);
    const directory = path.slice(0, path.lastIndexOf("node_modules/") + "node_modules/".length) + name;
    packages.set(directory, { name, directory });
  }
  return [...packages.values()].sort((a, b) => a.directory.localeCompare(b.directory));
}

export function bundlePackages(inputs) {
  return [...new Set(bundleInstallations(inputs).map(item => item.name))].sort();
}

export async function bundleNoticeText(root, inputs = []) {
  // Keep the complete reviewed notice inventory on partial speech builds too:
  // their output directory can still contain the previous UI/server bundles.
  // Validate actual input locations first; nested installs must not masquerade
  // as a different top-level package with the same name.
  const installations = bundleInstallations([...inputs, ...Object.keys(bundledLicenses).map(name => `node_modules/${name}/package.json`)]);
  const emitted = new Set();
  const sections = ["Pi Web Voice — bundled third-party JavaScript notices\n\nThe root MIT license applies to original project code, not as a replacement for the terms below. External model/phonemizer/runtime packs have separate notices and unresolved qualification gates; this inventory is not license clearance. See docs/licensing-audit.md and THIRD_PARTY.md."];
  for (const installation of installations) {
    const { name } = installation;
    const item = bundledLicenses[name];
    const directory = resolve(root, installation.directory);
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (pkg.name !== name || pkg.version !== item.version || pkg.license !== item.license) throw new Error(`Bundled license/version changed: ${name}`);
    const license = await readFile(item.file ? join(root, item.file) : join(directory, "LICENSE"), "utf8");
    if (!license.trim()) throw new Error(`Empty license: ${name}`);
    const section = `${name}@${item.version} — ${item.license}\n\n${license}`;
    if (!emitted.has(section)) { sections.push(section); emitted.add(section); }
  }
  // esbuild sees the prebuilt Transformers file, not its embedded Jinja package.
  // Its webpack source map identifies 0.5.3, not the separately installed 0.5.10.
  const sources = JSON.parse(await readFile(join(root, "scripts/dependency-sources.json"), "utf8"));
  const jinja = sources.embeddedPackages.find(item => item.name === "@huggingface/jinja");
  const map = JSON.parse(await readFile(join(root, "node_modules/@huggingface/transformers/dist/transformers.web.js.map"), "utf8"));
  const index = map.sources.findIndex(path => path.endsWith("/node_modules/@huggingface/jinja/dist/index.js"));
  const embedded = map.sourcesContent[index];
  if (typeof embedded !== "string" || createHash("sha256").update(embedded).digest("hex") !== jinja.embeddedSource.sha256) throw Error("Unreviewed prebundled Jinja source");
  sections.push(`@huggingface/jinja@${jinja.version} — MIT (embedded in Transformers.js)\n\n${await readFile(join(root, "scripts/speech-licenses/JINJA-LICENSE"), "utf8")}`);
  return sections.join("\n\n----------------------------------------\n\n") + "\n";
}

export async function writeBundleNotices(root, inputs) {
  await writeFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"), await bundleNoticeText(root, inputs));
}
