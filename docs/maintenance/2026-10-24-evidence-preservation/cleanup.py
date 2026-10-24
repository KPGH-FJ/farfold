#!/usr/bin/env python3
"""One-time exact-scope cleanup; raw protection inventories stay in output/.

Run `python3 <this-file> before` to inventory. The execute action is reserved for
the parent task after both authorized evidence batches have been pushed.
This script never follows directory symlinks, unmounts volumes, or runs Git writes.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[3]
PUBLIC = Path(__file__).resolve().parent
PRIVATE = ROOT / "output/2026-10-24-evidence-preservation-cleanup"
TARGETS = [
    "output/2026-10-10-quicklook-feasibility/module-cache",
    "output/2026-10-13-pptx-uno-prototype/engine",
    "output/2026-10-13-pptx-uno-prototype/sdk",
    "output/2026-10-13-pptx-uno-prototype/LibreOffice_26.2.6_MacOS_aarch64.dmg",
    "output/2026-10-13-pptx-uno-prototype/LibreOffice_26.2.6_MacOS_aarch64_sdk.dmg",
    "output/2026-10-13-pptx-uno-prototype/java-context-probe/jdk-extracted",
    "output/2026-10-13-pptx-uno-prototype/java-context-probe/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz",
]
MOUNT = "output/2026-10-10-libreoffice-stable-probe/sdk-mount"
DB_NAME = re.compile(r"\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$", re.I)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(args, timeout=60):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=timeout)
    return result.returncode, result.stdout, result.stderr


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def metadata(path):
    s = path.lstat()
    value = {
        "path": path.relative_to(ROOT).as_posix(),
        "mode": s.st_mode,
        "size": s.st_size,
        "device": s.st_dev,
        "inode": s.st_ino,
        "mtimeNs": s.st_mtime_ns,
    }
    if stat.S_ISLNK(s.st_mode):
        value["linkTarget"] = os.readlink(path)
    return value


def mounted_paths():
    code, stdout, stderr = run(["/sbin/mount"])
    if code:
        raise RuntimeError("Could not obtain mount inventory")
    mounts = []
    for line in stdout.decode().splitlines():
        if " on " in line and " (" in line:
            mounts.append((line.split(" on ", 1)[1].split(" (", 1)[0], line))
    return mounts


def under(path, parent):
    return path == parent or path.startswith(parent + os.sep)


def target_inventory(mounts):
    values = []
    for relative in TARGETS:
        path = ROOT / relative
        if not os.path.lexists(path):
            raise RuntimeError("Expected cleanup target absent: " + relative)
        # Inspect every ancestor. ROOT itself may resolve through the macOS Data volume.
        for ancestor in [path, *path.parents]:
            if ancestor == ROOT.parent:
                break
            if ancestor.is_symlink():
                raise RuntimeError("Symlink cleanup target or ancestor: " + relative)
        if not (path.is_file() or path.is_dir()):
            raise RuntimeError("Unsupported cleanup target: " + relative)
        if any(under(m, str(path)) for m, _ in mounts):
            raise RuntimeError("Mounted volume within cleanup target: " + relative)
        nodes = [path]
        if path.is_dir():
            for directory, dirs, files in os.walk(path, followlinks=False):
                if ".git" in dirs or ".git" in files:
                    raise RuntimeError("Nested Git within cleanup target: " + relative)
                for name in dirs + files:
                    if DB_NAME.search(name) or name.startswith("install-data-"):
                        raise RuntimeError("Protected data within cleanup target: " + relative)
                    nodes.append(Path(directory) / name)
        items = sorted((metadata(p) for p in nodes), key=lambda item: item["path"])
        values.append({
            "target": relative,
            "identity": metadata(path),
            "entries": len(items),
            "regularFileBytes": sum(x["size"] for x in items if stat.S_ISREG(x["mode"])),
            "allEntryApparentBytes": sum(x["size"] for x in items),
            "allocatedBytes": sum(p.lstat().st_blocks * 512 for p in nodes),
            "symlinks": sum(stat.S_ISLNK(x["mode"]) for x in items),
            "treeMetadataSha256": digest(items),
            "fileSha256": hash_file(path) if path.is_file() else None,
            "rootSymlink": False,
            "mountWithinTarget": False,
            "nestedGitWithinTarget": False,
            "protectedDataWithinTarget": False,
        })
    return values


def active_occupancy(label):
    # lsof includes cwd and memory mappings. Capture the full output only locally.
    code, stdout, stderr = run(["/usr/sbin/lsof", "-nP", "-Fpn"], timeout=60)
    (PRIVATE / (label + "-lsof.raw")).write_bytes(stdout)
    (PRIVATE / (label + "-lsof.stderr")).write_bytes(stderr)
    matches = []
    pid = None
    for line in stdout.decode(errors="replace").splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("n") and any(under(line[1:], str(ROOT / t)) for t in TARGETS):
            matches.append({"pid": pid, "name": line[1:]})
    pcode, pout, perr = run(["/bin/ps", "-axo", "pid=,ppid=,command="])
    (PRIVATE / (label + "-processes.raw")).write_bytes(pout)
    (PRIVATE / (label + "-processes.stderr")).write_bytes(perr)
    process_matches = [
        line for line in pout.decode(errors="replace").splitlines()
        if any(str(ROOT / t) in line for t in TARGETS)
    ]
    save(PRIVATE / (label + "-occupancy-matches.json"), {
        "openFiles": matches, "processCommands": process_matches,
    })
    result = {
        "lsofExitCode": code,
        "lsofWarningBytes": len(stderr),
        "psExitCode": pcode,
        "targetOpenFileMatches": len(matches),
        "targetProcessCommandMatches": len(process_matches),
    }
    if code or pcode or matches or process_matches:
        raise RuntimeError("Cleanup occupancy verification failed; inspect local records")
    return result


def protection_inventory(mounts):
    manifests = []
    all_jsonl = []
    databases = []
    nested = []
    summary_files = []
    mount_path = ROOT / MOUNT
    for directory, dirs, files in os.walk(ROOT / "output", followlinks=False):
        directory = Path(directory)
        dirs[:] = [
            d for d in dirs
            if directory / d not in [PRIVATE, mount_path]
            and not any(under(str(directory / d), str(ROOT / t)) for t in TARGETS)
            and d != ".git"
        ]
        marker = directory / ".git"
        if marker.exists():
            commands = {
                "head": ["rev-parse", "HEAD"],
                "status": ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                "indexEntries": ["ls-files", "--stage", "-z"],
                "worktreeDiff": ["diff", "--binary"],
                "indexDiff": ["diff", "--cached", "--binary"],
            }
            state = {"path": directory.relative_to(ROOT).as_posix()}
            for name, command in commands.items():
                code, out, err = run(["git", "-C", str(directory), *command])
                if code:
                    raise RuntimeError("Cannot inspect nested Git state")
                state[name + "Sha256"] = hashlib.sha256(out).hexdigest()
                if name == "status":
                    state["dirty"] = bool(out)
                    state["statusRecords"] = len([entry for entry in out.split(b"\0") if entry])
                if name == "head":
                    state["head"] = out.decode().strip()
            nested.append(state)
        for name in files:
            p = directory / name
            if p.is_symlink():
                continue
            if name.endswith(".jsonl"):
                all_jsonl.append(metadata(p))
            if name.startswith("install-data-") and name.endswith(".jsonl"):
                manifests.append(metadata(p))
            elif name.startswith("install-data-") and name.endswith("summary.json"):
                item = metadata(p)
                item["sha256"] = hash_file(p)
                summary_files.append(item)
            elif DB_NAME.search(name):
                item = metadata(p)
                item["sha256"] = hash_file(p)
                databases.append(item)
    for values in (manifests, all_jsonl, databases, nested, summary_files):
        values.sort(key=lambda item: item["path"])
    latest = max(manifests, key=lambda item: item["mtimeNs"]) if manifests else None
    latest_sha = hash_file(ROOT / latest["path"]) if latest else None
    mount_entries = [line for path, line in mounts if path == str(mount_path)]
    if not mount_entries:
        raise RuntimeError("Expected protected SDK mount is absent")
    installed_bundle = Path("/Applications/Farfold.app/Contents")
    with (installed_bundle / "Info.plist").open("rb") as source:
        executable_name = plistlib.load(source)["CFBundleExecutable"]
    installed = installed_bundle / "MacOS" / executable_name
    installed_hash = hash_file(installed)
    # No raw local paths are included in the public summary.
    raw = {
        "manifests": manifests, "databases": databases, "nestedRepositories": nested,
        "allNonTargetJsonl": all_jsonl,
        "manifestSummaryFiles": summary_files,
        "latestManifest": latest, "latestManifestSha256": latest_sha,
        "protectedMount": {"metadata": metadata(mount_path), "mountEntries": mount_entries},
        "installedExecutableSha256": installed_hash,
    }
    summary = {
        "inventoryScope": "All output paths including ignored and nested-repository paths; excludes seven cleanup targets, local private receipts and mounted volume contents",
        "allNonTargetJsonlCount": len(all_jsonl),
        "allNonTargetJsonlBytes": sum(x["size"] for x in all_jsonl),
        "allNonTargetJsonlMetadataSha256": digest(all_jsonl),
        "allNonTargetJsonlVerification": "All lstat metadata; historical JSONL contents are not fully reread",
        "manifestCount": len(manifests),
        "manifestBytes": sum(x["size"] for x in manifests),
        "manifestMetadataSha256": digest(manifests),
        "manifestVerification": "All lstat metadata; latest manifest content SHA-256; no full historical JSONL reread",
        "latestManifestSha256": latest_sha,
        "manifestSummaryCount": len(summary_files),
        "manifestSummaryContentSha256": digest(summary_files),
        "databaseCount": len(databases),
        "databaseBytes": sum(x["size"] for x in databases),
        "databaseMetadataAndContentSha256": digest(databases),
        "nestedRepositoryCount": len(nested),
        "dirtyNestedRepositoryCount": sum(x["dirty"] for x in nested),
        "nestedRepositoryStateSha256": digest(nested),
        "dirtyNestedRepositoryStatusRecords": sum(x["statusRecords"] for x in nested if x["dirty"]),
        "protectedMountCount": len(mount_entries),
        "protectedMountMetadataSha256": digest(raw["protectedMount"]),
        "installedExecutableSha256": installed_hash,
    }
    return raw, summary


def disk():
    usage = shutil.disk_usage(ROOT)
    return {"totalBytes": usage.total, "usedBytes": usage.used, "freeBytes": usage.free}


def before():
    if (PUBLIC / "cleanup-before.json").exists():
        raise RuntimeError("Before record already exists; do not silently replace baseline")
    mounts = mounted_paths()
    targets = target_inventory(mounts)
    occupancy = active_occupancy("before")
    raw, summary = protection_inventory(mounts)
    save(PRIVATE / "protected-before.private.json", raw)
    result = {
        "schema": 1, "recordedAt": now(), "phase": "prepared-no-deletion",
        "targets": targets, "occupancy": occupancy, "protected": summary,
        "disk": disk(),
        "totalRegularFileBytes": sum(x["regularFileBytes"] for x in targets),
        "totalAllocatedBytes": sum(x["allocatedBytes"] for x in targets),
        "privateInventorySha256": hash_file(PRIVATE / "protected-before.private.json"),
        "scope": "Seven enumerated targets only; data manifests, databases, mount, all nested Git and installed app protected",
    }
    save(PUBLIC / "cleanup-before.json", result)
    print(json.dumps({key: result[key] for key in ("phase", "totalRegularFileBytes", "totalAllocatedBytes", "occupancy", "protected")}, indent=2))


def execute():
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError("This Python does not support fd-safe recursive deletion")
    before_record = json.loads((PUBLIC / "cleanup-before.json").read_text())
    if (PUBLIC / "cleanup-after.json").exists():
        raise RuntimeError("After record already exists; cleanup cannot be repeated")
    mounts = mounted_paths()
    current = target_inventory(mounts)
    if current != before_record["targets"]:
        raise RuntimeError("Cleanup target metadata or content identity changed")
    occupancy = active_occupancy("pre-delete")
    raw, summary = protection_inventory(mounts)
    if summary != before_record["protected"]:
        save(PRIVATE / "protected-predelete.private.json", raw)
        raise RuntimeError("Protected state changed before cleanup; reconcile before deleting")
    disk_before = disk()
    deleted = []
    for target in TARGETS:
        path = ROOT / target
        if path.is_symlink() or os.path.ismount(path):
            raise RuntimeError("Cleanup target became a symlink or mount")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        deleted.append(target)
        save(PRIVATE / "delete-progress.json", {"at": now(), "deleted": deleted})
    disk_immediate = disk()
    after_mounts = mounted_paths()
    raw_after, after_summary = protection_inventory(after_mounts)
    save(PRIVATE / "protected-after.private.json", raw_after)
    unchanged = after_summary == before_record["protected"]
    remaining = [target for target in TARGETS if os.path.lexists(ROOT / target)]
    result = {
        "schema": 1, "recordedAt": now(), "phase": "cleaned" if not remaining and unchanged else "verification-failed",
        "deletedTargets": deleted, "remainingTargets": remaining,
        "totalRegularFileBytesRemoved": before_record["totalRegularFileBytes"],
        "totalAllocatedBytesBefore": before_record["totalAllocatedBytes"],
        "occupancyImmediatelyBeforeDeletion": occupancy,
        "protected": after_summary, "protectedSummaryUnchanged": unchanged,
        "privateAfterInventorySha256": hash_file(PRIVATE / "protected-after.private.json"),
        "diskImmediatelyBeforeDeletion": disk_before,
        "diskImmediatelyAfterDeletion": disk_immediate,
        "observedFreeBytesChange": disk_immediate["freeBytes"] - disk_before["freeBytes"],
        "diskMeasurementLimit": "APFS free-space delta is a whole-volume observation; concurrent writes, clones and snapshots affect it",
        "scope": "No mount unmounted, database or data manifest removed, nested Git changed, or installed app replaced",
    }
    save(PUBLIC / "cleanup-after.json", result)
    print(json.dumps(result, indent=2))
    if remaining or not unchanged:
        raise RuntimeError("Post-cleanup verification failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["before", "execute-after-two-pushes"])
    args = parser.parse_args()
    PRIVATE.mkdir(parents=True, exist_ok=True)
    before() if args.action == "before" else execute()
