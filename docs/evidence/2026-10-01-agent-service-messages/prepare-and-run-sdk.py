#!/usr/bin/env python3
"""Prepare only fixed official public SDK artifacts; run a loopback canary."""

import base64
import concurrent.futures
import hashlib
import hmac
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
import urllib.parse

BASE = Path(__file__).resolve().parent
ARCHIVE_LIMIT = 8 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024
PACKAGE_LIMIT = 64 * 1024 * 1024
ENTRY_LIMIT = 10000
MANIFEST_LIMIT = 256 * 1024
EXPECTED = {
    "@ai-sdk/anthropic": "3.0.111",
    "@ai-sdk/provider": "3.0.15",
    "@ai-sdk/provider-utils": "4.0.46",
    "zod": "4.1.8",
    "json-schema": "0.4.0",
    "undici": "6.28.0",
    "eventsource-parser": "3.0.8",
    "@standard-schema/spec": "1.1.0",
}
SAFE_FAILURES = {
    "ARTIFACT_REDIRECT_REJECTED", "ARTIFACT_SOURCE_REJECTED",
    "ARTIFACT_RESPONSE_REJECTED", "ARTIFACT_SIZE_REJECTED",
    "ARTIFACT_INTEGRITY_KIND_REJECTED", "ARTIFACT_INTEGRITY_MISMATCH",
    "ARTIFACT_SHASUM_MISMATCH", "ARTIFACT_ENTRY_LIMIT",
    "ARTIFACT_ENTRY_REJECTED", "ARTIFACT_DUPLICATE_ENTRY",
    "ARTIFACT_EXPANDED_LIMIT", "ARTIFACT_FILE_MISSING",
    "ARTIFACT_FILE_SIZE_MISMATCH", "ARTIFACT_MANIFEST_LIMIT",
    "ARTIFACT_MANIFEST_MISMATCH", "ARTIFACT_INSTALL_SCRIPT_PRESENT",
    "NODE_UNAVAILABLE", "ARTIFACT_DOWNLOAD_FAILED",
}


def save(name, value):
    (BASE / name).write_text(json.dumps(value, indent=2) + "\n")


def download(record, archive_root, summaries):
    url = record["dist"]["tarball"]
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "registry.npmjs.org"
        or parsed.query
        or parsed.fragment
        or not parsed.path.endswith(".tgz")
    ):
        raise RuntimeError("ARTIFACT_SOURCE_REJECTED")
    stem = hashlib.sha256(record["name"].encode()).hexdigest()
    archive_path = archive_root / stem
    header_path = archive_root / (stem + ".headers")
    summary = {"name": record["name"], "version": record["version"],
               "archiveLimit": ARCHIVE_LIMIT}
    summaries.append(summary)
    # No redirects, curl configuration, proxy inheritance or unbounded retries.
    completed = subprocess.run(
        ["curl", "-q", "--noproxy", "*", "--compressed", "--retry", "2",
         "--retry-all-errors", "--connect-timeout", "5", "--max-time", "12",
         "--max-filesize", str(ARCHIVE_LIMIT), "--silent", "--show-error",
         "--fail", "--output", str(archive_path), "--dump-header", str(header_path),
         "--write-out", "%{http_code}\\n%{size_download}\\n", url],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=42, check=False,
    )
    summary["curlExitCode"] = completed.returncode
    summary["stderrBytes"] = len(completed.stderr)
    fields = completed.stdout.decode("ascii", errors="ignore").splitlines()
    summary["httpStatus"] = int(fields[0]) if fields and fields[0].isdigit() else None
    summary["transferredBytes"] = (
        int(float(fields[1])) if len(fields) > 1 and fields[1].replace(".", "", 1).isdigit() else None
    )
    summary["declaredLength"] = None
    summary["contentEncoding"] = "identity"
    if header_path.exists():
        for line in header_path.read_text(errors="replace").splitlines():
            key, _, value = line.partition(":")
            if key.lower() == "content-length" and value.strip().isdigit():
                summary["declaredLength"] = int(value.strip())
            if key.lower() == "content-encoding":
                summary["contentEncoding"] = (
                    value.strip().lower() if value.strip().lower() in ("gzip", "identity") else "other"
                )
    summary["actualArchiveBytes"] = archive_path.stat().st_size if archive_path.exists() else 0
    if completed.returncode != 0:
        summary["fixedReason"] = "ARTIFACT_DOWNLOAD_FAILED"
        raise RuntimeError("ARTIFACT_DOWNLOAD_FAILED")
    if summary["httpStatus"] != 200:
        summary["fixedReason"] = "ARTIFACT_RESPONSE_REJECTED"
        raise RuntimeError("ARTIFACT_RESPONSE_REJECTED")
    if summary["actualArchiveBytes"] > ARCHIVE_LIMIT:
        summary["fixedReason"] = "ARTIFACT_SIZE_REJECTED"
        raise RuntimeError("ARTIFACT_SIZE_REJECTED")
    body = archive_path.read_bytes()
    algorithm, encoded = record["dist"]["integrity"].split("-", 1)
    if algorithm != "sha512":
        raise RuntimeError("ARTIFACT_INTEGRITY_KIND_REJECTED")
    expected = base64.b64decode(encoded, validate=True)
    digest = hashlib.sha512(body).digest()
    if not hmac.compare_digest(expected, digest):
        summary["fixedReason"] = "ARTIFACT_INTEGRITY_MISMATCH"
        raise RuntimeError("ARTIFACT_INTEGRITY_MISMATCH")
    if hashlib.sha1(body).hexdigest() != record["dist"]["shasum"]:
        raise RuntimeError("ARTIFACT_SHASUM_MISMATCH")
    summary["integrityVerified"] = True
    return record, body, digest.hex()


def extract(record, body, root):
    target = root / "node_modules" / record["name"]
    target.mkdir(parents=True)
    total = 0
    seen = set()
    count = 0
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
        members = archive.getmembers()
        if len(members) > ENTRY_LIMIT:
            raise RuntimeError("ARTIFACT_ENTRY_LIMIT")
        # Validate every path and type before creating any package file.
        for member in members:
            path = PurePosixPath(member.name)
            if (
                len(member.name) > 1024
                or "\\" in member.name
                or path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] != "package"
                or not (member.isdir() or member.isreg())
                or member.size < 0
                or member.size > FILE_LIMIT
            ):
                raise RuntimeError("ARTIFACT_ENTRY_REJECTED")
            relative = Path(*path.parts[1:])
            if relative in seen or (not relative.parts and not member.isdir()):
                raise RuntimeError("ARTIFACT_DUPLICATE_ENTRY")
            seen.add(relative)
            total += member.size
            if total > PACKAGE_LIMIT:
                raise RuntimeError("ARTIFACT_EXPANDED_LIMIT")
        for member in members:
            relative = Path(*PurePosixPath(member.name).parts[1:])
            destination = target / relative
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            stream = archive.extractfile(member)
            if stream is None:
                raise RuntimeError("ARTIFACT_FILE_MISSING")
            contents = stream.read(FILE_LIMIT + 1)
            if len(contents) != member.size:
                raise RuntimeError("ARTIFACT_FILE_SIZE_MISMATCH")
            with destination.open("xb") as output:
                output.write(contents)
            destination.chmod(0o644)
            count += 1
    manifest_path = target / "package.json"
    if manifest_path.stat().st_size > MANIFEST_LIMIT:
        raise RuntimeError("ARTIFACT_MANIFEST_LIMIT")
    manifest = json.loads(manifest_path.read_text())
    if (
        manifest.get("name") != record["name"]
        or manifest.get("version") != record["version"]
        or manifest.get("dependencies", {}) != record["dependencies"]
        or manifest.get("optionalDependencies", {})
    ):
        raise RuntimeError("ARTIFACT_MANIFEST_MISMATCH")
    install_names = [
        name for name in ("preinstall", "install", "postinstall")
        if name in manifest.get("scripts", {})
    ]
    if install_names:
        raise RuntimeError("ARTIFACT_INSTALL_SCRIPT_PRESENT")
    return {
        "name": manifest["name"],
        "version": manifest["version"],
        "dependencies": manifest.get("dependencies", {}),
        "peerDependencies": manifest.get("peerDependencies", {}),
        "engines": manifest.get("engines", {}),
        "manifestSHA256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "regularFiles": count,
        "expandedBytes": total,
        "installScriptsExecuted": False,
    }


records = json.loads((BASE / "sdk-packages.json").read_text())["packages"]
if {row["name"]: row["version"] for row in records} != EXPECTED or not all(
    row["existsAtLeast7DaysOn2026_10_01"] is True for row in records
):
    raise RuntimeError("FIXED_GRAPH_REJECTED")

root = Path(tempfile.mkdtemp(prefix="farfold-messages-sdk-canary-", dir="/tmp")).resolve()
receipt = {
    "schema": 1,
    "startedAtUTC": datetime.now(timezone.utc).isoformat(),
    "temporaryDirectory": str(root),
    "repoDependenciesChanged": False,
    "agentOrUserConfigOpened": False,
    "privateHomeCreated": False,
    "packages": [],
    "prepared": False,
    "sdkExitCode": None,
    "cleanupConfirmed": False,
}
exit_code = 1
try:
    receipt["phase"] = "download"
    archive_root = root / "archives"
    archive_root.mkdir()
    receipt["downloadSummaries"] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        downloaded = list(pool.map(
            lambda row: download(row, archive_root, receipt["downloadSummaries"]), records
        ))
    receipt["phase"] = "extract"
    for record, body, digest in downloaded:
        receipt["currentPublicPackage"] = record["name"]
        manifest = extract(record, body, root)
        receipt["packages"].append({
            **manifest,
            "source": record["dist"]["tarball"],
            "archiveBytes": len(body),
            "archiveSHA512": digest,
            "integrityVerified": True,
            "publishedAt": record["publishedAt"],
        })
    receipt["prepared"] = True
    receipt["phase"] = "probe"
    save("sdk-tool-preparation.json", receipt)
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("NODE_UNAVAILABLE")
    # No inherited value or exception text is read or logged. The canary itself
    # replaces relevant auth variables before loading the verified official SDK.
    environment = os.environ.copy()
    # Avoid unrelated Node preload/modules changing this task-only probe.
    # The values of these keys are neither inspected nor recorded.
    environment.pop("NODE_OPTIONS", None)
    environment.pop("NODE_PATH", None)
    completed = subprocess.run(
        [node, str(BASE / "messages-sdk-canary.mjs"), "--sdk-root",
         str(root / "node_modules" / "@ai-sdk" / "anthropic"), "--out",
         str(BASE / "sdk-loopback.json")],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=65, check=False,
        env=environment,
    )
    receipt["sdkExitCode"] = completed.returncode
    receipt["sdkStdoutBytes"] = len(completed.stdout)
    receipt["sdkStderrBytes"] = len(completed.stderr)
    # Parse only the bounded script report already saved inside evidence.
    report = json.loads((BASE / "sdk-loopback.json").read_text())
    receipt["sdkRequests"] = report.get("networkRequests")
    receipt["sdkExecuted"] = report.get("executed")
    receipt["sdkPassed"] = report.get("passed")
    exit_code = completed.returncode
except Exception as error:
    # Error class only; network/module error text may contain paths or values.
    receipt["preparationErrorClass"] = type(error).__name__
    if isinstance(error, RuntimeError) and str(error) in SAFE_FAILURES:
        receipt["preparationErrorCode"] = str(error)
finally:
    # This exact unique directory is owned by this invocation. No name search or
    # prefix deletion of any other path is used.
    if root.parent != Path("/tmp").resolve() or not root.name.startswith("farfold-messages-sdk-canary-"):
        receipt["cleanupRefused"] = True
        exit_code = 1
    else:
        shutil.rmtree(root)
        receipt["cleanupConfirmed"] = not root.exists()
        if not receipt["cleanupConfirmed"]:
            exit_code = 1
    receipt["finishedAtUTC"] = datetime.now(timezone.utc).isoformat()
    receipt["exitCode"] = exit_code
    save("sdk-tool-preparation.json", receipt)
print(json.dumps({key: receipt.get(key) for key in (
    "prepared", "sdkExitCode", "sdkRequests", "sdkExecuted", "sdkPassed",
    "cleanupConfirmed", "preparationErrorClass", "exitCode",
)}))
raise SystemExit(exit_code)
