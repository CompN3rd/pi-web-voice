"""Offline source-evidence check. Reads tar members without extracting or running upstream code."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import posixpath
import stat
import tarfile

ROOT = Path(__file__).resolve().parent.parent


def artifact(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def archive_digest(path, algorithm, *, expected_size=None, max_size=128_000_000):
    info = path.lstat()
    limit = expected_size if expected_size is not None else max_size
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit or (expected_size is not None and info.st_size != expected_size):
        raise ValueError(f"Archive length/type mismatch: {path}")
    digest = hashlib.new(algorithm)
    total = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise ValueError(f"Archive exceeds size bound: {path}")
            digest.update(chunk)
    if total != info.st_size:
        raise ValueError(f"Archive changed during verification: {path}")
    return digest.digest()


def checked_archive(directory, pin):
    path = directory / pin["archive"]
    if archive_digest(path, "sha256", expected_size=pin["bytes"]).hex() != pin["sha256"]:
        raise ValueError(f"Archive integrity mismatch: {path}")
    return tarfile.open(path, "r:gz")


def member(archive, path):
    entry = archive.getmember(path)
    if not entry.isfile():
        raise ValueError(f"Not a regular archive member: {path}")
    return archive.extractfile(entry).read()


def verify(source_directory, package_directory):
    inventory = json.loads((ROOT / "scripts/dependency-sources.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    summaries = []
    for pin in inventory["archives"]:
        with checked_archive(source_directory, pin) as source:
            prefix = pin["root"] + "/"
            for path, expected in pin["evidenceFiles"].items():
                if artifact(member(source, prefix + path)) != expected:
                    raise ValueError(f"Source/build evidence mismatch: {pin['id']}/{path}")
            if pin["id"] == "ort-web":
                native = inventory["onnxNative"]
                deps = member(source, prefix + native["manifest"])
                rows = [dict(zip(("name", "url", "sha1"), line.split(";")))
                        for line in deps.decode().splitlines() if line and not line.startswith("#")]
                if artifact(deps) != native["manifestArtifact"] or rows != native["declaredDependencies"]:
                    raise ValueError("ONNX declared native dependency inventory changed")
            for pkg in inventory["packages"] + inventory["embeddedPackages"]:
                if pkg["sourceArchive"] != pin["id"]:
                    continue
                name = pkg["name"]
                if "packageArchive" in pkg:
                    package = checked_archive(source_directory, pkg["packageArchive"])
                else:
                    filename = name.replace("/", "-").replace("@", "") + "-" + pkg["version"] + ".tgz"
                    path = package_directory / filename
                    integrity = "sha512-" + base64.b64encode(archive_digest(path, "sha512")).decode()
                    if integrity != lock["packages"]["node_modules/" + name]["integrity"]:
                        raise ValueError(f"Npm archive integrity mismatch: {name}")
                    package = tarfile.open(path, "r:gz")
                with package:
                    rule = pkg["sourceComparison"]
                    source_root = posixpath.normpath(prefix + pkg["sourceDirectory"])
                    count = 0
                    if "directory" in rule:
                        for entry in package.getmembers():
                            path = entry.name.removeprefix("package/")
                            if not entry.isfile() or not path.startswith(rule["directory"] + "/") or not path.endswith(rule["suffix"]):
                                continue
                            upstream = member(source, source_root + "/" + path)
                            published = member(package, entry.name)
                            if path == rule.get("generatedVersion"):
                                # Upstream's release script substitutes the dev version only.
                                published = published.replace(pkg["version"].encode(), b"1.22.0")
                            else:
                                count += 1
                            if upstream != published:
                                raise ValueError(f"Preferred source differs: {name}/{path}")
                        if count != rule["matches"]:
                            raise ValueError(f"Source comparison coverage changed: {name}: {count}")
                    for path in rule.get("sourceMaps", []):
                        mapping = json.loads(member(package, "package/" + path))
                        for origin, content in zip(mapping["sources"], mapping["sourcesContent"], strict=True):
                            source_path = posixpath.normpath(source_root + "/" + posixpath.dirname(path) + "/" + origin)
                            if member(source, source_path) != content.encode():
                                raise ValueError(f"Source map differs: {name}/{path}: {origin}")
                            count += 1
                    if "publicApiArtifact" in pkg:
                        expected = pkg["publicApiArtifact"]
                        if artifact(member(package, "package/" + expected["path"])) != {k: expected[k] for k in ("bytes", "sha256")}:
                            raise ValueError("Pi Web public API artifact changed")
                    if name == "@huggingface/transformers":
                        mapping = json.loads(member(package, "package/dist/transformers.web.js.map"))
                        embedded = [(origin, content) for origin, content in zip(mapping["sources"], mapping["sourcesContent"], strict=True) if "/node_modules/" in origin]
                        if len(embedded) != 1 or not embedded[0][0].endswith("/@huggingface/jinja/dist/index.js") or artifact(embedded[0][1].encode()) != inventory["embeddedPackages"][0]["embeddedSource"]:
                            raise ValueError("Transformers embedded package evidence changed")
                    if name == "@huggingface/jinja" and artifact(member(package, "package/dist/index.js")) != pkg["embeddedSource"]:
                        raise ValueError("Jinja npm/webpack source mismatch")
                    if name == "onnxruntime-web" and member(package, "package/__commit.txt").decode().strip() != pin["revision"]:
                        raise ValueError("ONNX npm native commit mismatch")
                    summaries.append(f"{name}@{pkg['version']}: source/build evidence verified; {count} preferred-source comparisons")
    return summaries


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-archives", required=True, type=Path)
    parser.add_argument("--dependency-archives", required=True, type=Path)
    args = parser.parse_args()
    print("\n".join(verify(args.source_archives, args.dependency_archives)))
    print("Archive evidence only: no native reproduction, recursive source closure or release clearance claimed.")
