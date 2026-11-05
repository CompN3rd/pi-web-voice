#!/usr/bin/env python3
"""Build a standalone candidate, not a production pack. Original tooling: MIT.

Linux x86_64, Python >=3.12. Everything generated stays in explicit external
/data directories. No SDK activation, package install, native host compiler,
CMake, weights, npm dependencies or paid requests. Downloads require opt-in.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())
NATIVE_SOURCES = """common mnemonics error ieee80 compiledata compiledict dictionary
encoding intonation langopts numbers phoneme phonemelist readclause setlengths
soundicon spect ssml synthdata synthesize tr_languages translate translateword
voices wavegen speech espeak_api""".split()
UCD_SOURCES = "case categories ctype proplist scripts tostring".split()
DATA_FILES = ["en_dict", "intonations", "lang/gmw/en", "lang/gmw/en-US", "phondata", "phonindex", "phontab"]


def digest(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def metadata(path):
    return {"bytes": path.stat().st_size, "sha256": digest(path)}


def external(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("Use an absolute external /data path")
    path = path.resolve()
    # Also works when invoked from the extracted standalone source bundle.
    source_root = HERE.parents[1] if HERE.parent.name == "scripts" else HERE.parent
    if not path.is_relative_to("/data") or path == Path("/data") or path.is_relative_to(source_root):
        raise ValueError("Build/download paths must be outside the source tree and below /data")
    if path.exists() and any(p.is_symlink() for p in path.rglob("*")):
        raise ValueError("Existing output/download directories must not contain symlinks")
    return path


def acquire(item, downloads, allow_download):
    target = downloads / item["name"]
    if not target.exists():
        if not allow_download:
            raise ValueError(f"Missing {target}; explicitly use --download to acquire pinned public tools/source")
        temporary = target.with_suffix(target.suffix + ".partial")
        with urllib.request.urlopen(item["url"], timeout=120) as response, temporary.open("wb") as out:
            shutil.copyfileobj(response, out)
        if digest(temporary) != item["sha256"]:
            temporary.unlink()
            raise ValueError(f"Integrity failure: {item['name']}")
        temporary.rename(target)
    if digest(target) != item["sha256"]:
        raise ValueError(f"Integrity failure: {item['name']}")
    return target


def extract(archive, directory):
    directory.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        source.extractall(directory, filter="data")


def archive_tree(directory, output):
    # Stable tar/gzip metadata; file contents and executable bits are retained.
    def stable(info):
        info.uid = info.gid = info.mtime = 0
        info.uname = info.gname = ""
        info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
        return info
    with output.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
            tar.add(directory, arcname="source", filter=stable)


def build_environment(work, config):
    # Do not inherit SDK/compiler/Python/loader overrides or user configuration.
    # Emscripten EM_LLVM_ROOT/EM_BINARYEN_ROOT/EM_NODE_JS override EM_CONFIG.
    return {"PATH": "/usr/bin:/bin", "HOME": str(work / "home"),
            "EM_CONFIG": str(config), "EM_CACHE": str(work / "cache"),
            "EMCC_CORES": "2", "LC_ALL": "C", "TZ": "UTC",
            "SOURCE_DATE_EPOCH": "0", "TMPDIR": str(work / "tmp"), "PYTHONUTF8": "1"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="new/empty external /data build directory")
    parser.add_argument("--downloads", required=True, help="external /data pinned archive cache")
    parser.add_argument("--download", action="store_true", help="explicitly allow missing pinned public archives")
    args = parser.parse_args()
    if sys.version_info < (3, 12) or sys.platform != "linux" or platform.machine() != "x86_64":
        parser.error("Requires Linux x86_64 and Python >=3.12")
    output, downloads = external(args.output), external(args.downloads)
    if output == downloads or downloads.is_relative_to(output) or output.is_relative_to(downloads):
        parser.error("Use separate output and download directories")
    if output.exists() and any(output.iterdir()):
        parser.error("Output must be empty; no automatic deletion or overwrite")
    downloads.mkdir(parents=True, exist_ok=True)
    inputs = {item["name"]: acquire(item, downloads, args.download) for item in PINS["inputs"]}
    output.mkdir(parents=True, exist_ok=True)
    work = output / "work"
    extract(inputs["espeak-ng.tar.gz"], work)
    extract(inputs["emscripten.tar.xz"], work / "toolchain")
    extract(inputs["node.tar.xz"], work / "toolchain")
    source = work / ("espeak-ng-" + PINS["nativeRevision"])
    emscripten = work / "toolchain/install/emscripten"
    node = work / ("toolchain/node-v" + PINS["nodeVersion"] + "-linux-x64/bin/node")
    config = work / "emscripten.config"
    config.write_text(f"LLVM_ROOT = {str(emscripten.parent / 'bin')!r}\n"
                      f"BINARYEN_ROOT = {str(emscripten.parent)!r}\n"
                      f"NODE_JS = [{str(node)!r}]\nCACHE = {str(work / 'cache')!r}\n")
    env = build_environment(work, config)
    (work / "home").mkdir()
    (work / "tmp").mkdir()
    commands = []
    log = output / "build.log"

    def run(command, cwd=work):
        command = list(map(str, command))
        commands.append({"argv": command, "cwd": str(cwd)})
        with log.open("ab") as stream:
            stream.write(("\n$ " + repr(command) + "\n").encode())
            stream.flush()
            subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True)

    emcc = emscripten / "emcc"
    run([emcc, "--version"])
    run([node, "--version"])
    sources = [source / f"src/libespeak-ng/{name}.c" for name in NATIVE_SOURCES]
    sources += [source / f"src/ucd-tools/src/{name}.c" for name in UCD_SOURCES]
    common = [emcc, "-O2", "-fwrapv", "-DHAVE_CONFIG_H", "-DLIBESPEAK_NG_EXPORT=1",
              '-DPATH_ESPEAK_DATA="/espeak-ng-data"',
              f"-ffile-prefix-map={source}=/espeak-ng", f"-ffile-prefix-map={HERE}=/builder", "-I" + str(HERE),
              "-I" + str(source / "src/include"), "-I" + str(source / "src/include/compat"),
              "-I" + str(source / "src/ucd-tools/src/include"),
              # musl wchar declarations must precede upstream wctype macro remaps.
              "-include", "wchar.h", *sources]
    # The data compiler is WASM too. NODERAWFS is ONLY for this offline build
    # executable, never linked into the browser candidate.
    compiler = work / "espeak.cjs"
    run([*common, source / "src/espeak-ng.c", "-sNODERAWFS=1", "-sENVIRONMENT=node",
         "-sALLOW_MEMORY_GROWTH=1", "-o", compiler])
    data = work / "espeak-ng-data"
    (data / "lang/gmw").mkdir(parents=True)
    for voice in ["en", "en-US"]:
        shutil.copyfile(source / "espeak-ng-data/lang/gmw" / voice, data / "lang/gmw" / voice)
    shutil.copytree(source / "phsource", work / "phsource")
    dictionary = work / "dictsource"
    dictionary.mkdir()
    for name in ["en_rules", "en_list", "en_emoji"]:
        shutil.copyfile(source / "dictsource" / name, dictionary / name)
    run([node, compiler, "--path=.", "--compile-intonations"])
    run([node, compiler, "--path=.", "--compile-phonemes"])
    run([node, compiler, "--path=..", "--compile=en"], cwd=dictionary)
    embed = []
    for name in DATA_FILES:
        embed.extend(["--embed-file", f"{data / name}@/espeak-ng-data/{name}"])
    engine = work / "engine.mjs"
    run([*common, HERE / "bridge.c", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createEspeak",
         "-sENVIRONMENT=web,worker", "-sSINGLE_FILE=1", "-sALLOW_MEMORY_GROWTH=1", "-sFILESYSTEM=1",
         '-sEXPORTED_FUNCTIONS=["_pv_init","_pv_begin","_pv_pending","_pv_next","_malloc","_free"]',
         '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","stringToUTF8","lengthBytesUTF8"]',
         *embed, "-o", engine])
    candidate = output / "phonemizer.mjs"
    candidate.write_bytes(b"/* eSpeak NG 1.52.0 candidate: GPL-3.0-or-later. See SOURCE.json and source.tar.gz. */\n"
                          + engine.read_bytes() + b"\n" + (HERE / "phonemizer.mjs").read_bytes())

    source_bundle = output / "source"
    (source_bundle / "inputs").mkdir(parents=True)
    shutil.copyfile(inputs["espeak-ng.tar.gz"], source_bundle / "inputs/espeak-ng.tar.gz")
    builder = source_bundle / "builder"
    builder.mkdir()
    for name in ["build.py", "pins.json", "config.h", "bridge.c", "phonemizer.mjs", "README.md", "LICENSE", "test_build.py"]:
        shutil.copyfile(HERE / name, builder / name)
    # Embedded runtime's preferred source and all its in-tree notices, not
    # merely a compiler URL. General-purpose compiler binaries stay external.
    runtime_source = source_bundle / "emscripten-runtime"
    runtime_source.mkdir()
    for name in ["src", "system"]:
        shutil.copytree(emscripten / name, runtime_source / name)
    for name in ["LICENSE", "AUTHORS"]:
        shutil.copyfile(emscripten / name, runtime_source / name)
    notices = output / "NOTICES.txt"
    sections = [("Candidate boundary", (HERE / "README.md").read_text()),
                ("Original bridge/build/wrapper MIT", (HERE / "LICENSE").read_text())]
    for path in sorted(source.glob("COPYING*")):
        sections.append(("eSpeak NG " + path.name, path.read_text()))
    for name in ["LICENSE", "system/lib/libc/musl/COPYRIGHT", "system/lib/compiler-rt/LICENSE.TXT",
                 "system/lib/libcxx/LICENSE.TXT", "system/lib/libcxxabi/LICENSE.TXT"]:
        sections.append(("Emscripten " + name, (emscripten / name).read_text()))
    notices.write_text("\n\n".join(f"===== {name} =====\n{text}" for name, text in sections))
    mapping = {
        "schema": 1, "candidate": PINS["candidate"], "combinedCandidateLicense": "GPL-3.0-or-later",
        "productionIntegrated": False, "qualification": "Standalone source-built candidate, not release or model/device acceptance",
        "binary": {"path": candidate.name, **metadata(candidate)}, "pins": PINS,
        "patches": [], "configuration": "builder/config.h and exact argv in build-record.json; forced wchar.h inclusion",
        "builderInputs": {name: metadata(builder / name) for name in sorted(p.name for p in builder.iterdir())},
        "data": {name: metadata(data / name) for name in DATA_FILES},
        "dataSources": {"en_dict": "native dictsource/en_rules + en_list + en_emoji",
                        "phondata/phonindex/phontab/intonations": "native phsource tree compiled by same pinned WASM eSpeak CLI",
                        "lang/gmw/en, lang/gmw/en-US": "unchanged native espeak-ng-data/lang/gmw files"},
        "runtimeSources": "emscripten-runtime/src and system from hash-verified toolchain archive",
        "nativeSource": "inputs/espeak-ng.tar.gz (complete unmodified tree, including all in-tree licenses/attribution)",
        "scope": "Engine candidate only; not the full Pi Web Voice combined-work source distribution"
    }
    record = {"commands": commands, "host": {"python": sys.version, "platform": platform.platform()},
              "environment": env,
              "log": metadata(log), "sourceMapping": mapping}
    (output / "build-record.json").write_text(json.dumps(record, indent=2) + "\n")
    (source_bundle / "SOURCE.json").write_text(json.dumps(mapping, indent=2) + "\n")
    shutil.copyfile(output / "build-record.json", source_bundle / "build-record.json")
    shutil.copyfile(notices, source_bundle / notices.name)
    archive_tree(source_bundle, output / "source.tar.gz")
    mapping["sourceArchive"] = {"path": "source.tar.gz", **metadata(output / "source.tar.gz")}
    mapping["notices"] = {"path": notices.name, **metadata(notices)}
    (output / "SOURCE.json").write_text(json.dumps(mapping, indent=2) + "\n")
    print(json.dumps({"output": str(output), "binary": mapping["binary"], "sourceArchive": mapping["sourceArchive"]}, indent=2))


if __name__ == "__main__":
    main()
