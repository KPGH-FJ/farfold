#!/usr/bin/env python3
"""Publish a fixed, bounded evidence selection without opening databases or apps.

This transforms copies only. It does not rerun historical commands, stage files,
remove source evidence, or inspect data manifest contents. Public paths refer to
repository-owned evidence; private source contents remain local.
"""

import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess


REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / "output/2026-10-22-common-capability-closeout"
DOCS = REPO / "docs/evidence/2026-10-22-common-capability-closeout"
DEST = DOCS / "preserved-evidence"
MAINT = REPO / "docs/maintenance/2026-10-24-evidence-preservation"
ROOT_NAMES = [
    "selected-stage-e616.json",
    "formal-18470-installation.json",
    "formal-18470-ui-observation.json",
]
RAW_RUNS = ["39958119731", "39945651058", "39948790029"]
PROTECTED_SUFFIXES = {".sqlite3", ".db", ".png", ".zip", ".tgz"}
PROTECTED_NAMES = {
    "launch-state-full.txt",
    "retained-worktree-unknown.txt",
    "processes-before-normal-quit.json",
}
text_exts = {".json", ".jsonl", ".log", ".txt", ".xml", ".py", ".ps1", ".diff", ".patch"}


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    return path.relative_to(REPO).as_posix()


def eid(path):
    return "e-" + digest_bytes(rel(path).encode())[:20]


def protected(path):
    n = path.name.lower()
    if path.name in PROTECTED_NAMES:
        return "private installed UI, accessibility text, screenshot, or process arguments"
    if path.suffix in PROTECTED_SUFFIXES or n.endswith(("-wal", "-shm")):
        return "database, sidecar, screenshot, or binary archive; not opened or copied"
    if "install-data-" in n and path.suffix == ".jsonl":
        return "complete user-data manifest; contents not opened"
    return None


def strings(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, str):
        yield value


def exact_path(value):
    if value.startswith(str(REPO) + "/"):
        p = Path(value)
    elif value.startswith(("output/2026-10-22-common-capability-closeout/", "docs/evidence/2026-10-22-common-capability-closeout/")):
        p = REPO / value
    else:
        return None
    try:
        p.relative_to(SOURCE)
    except ValueError:
        try:
            p.relative_to(DOCS)
        except ValueError:
            return None
    return p


def references(value):
    for s in strings(value):
        p = exact_path(s)
        if p is not None:
            yield p


def load_json(path):
    return json.loads(path.read_text())


selection = {DOCS / n for n in ROOT_NAMES}
# The three receipts' direct evidence dependencies are the starting scope.
for path in list(selection):
    selection.update(p for p in references(load_json(path)) if p.is_file())
# Full latest, known intermittent failure, and previous 140 + separate 27 raw CI
# cohorts are small controlled artifacts, rather than summaries alone.
for run in RAW_RUNS:
    selection.update(p for p in (SOURCE / f"windows-ci-{run}-1").rglob("*") if p.is_file())
# These fixed directories contain the current seven checks and affected checks.
for directory in ["engineering-final-r12", "windows-git-detached-stdio-r1"]:
    selection.update(p for p in (SOURCE / directory).rglob("*") if p.is_file())
# Pin the three downloads and their direct independent provenance and failures.
for name in [
    "download-39945651058-attempt1-r1.json",
    "download-39948790029-attempt1-r1.json",
    "recovery-39945651058-attempt1-independent-review-r1.json",
    "run-39958119731-attempt1-independent-inputs-r1.json",
    "run-39958119731-attempt1-independent-cases-r1.json",
    "run-39948790029-attempt1-fixed-legacy-r2.json",
    "run-39948790029-attempt1-fixed-legacy-r2.current-receipts.json",
    "run-39948790029-attempt1-legacy27-r1.json",
]:
    selection.add(SOURCE / "windows-ci-tools" / name)
selection.add(SOURCE / "formal-delivery-r2/candidate-output/build.log")
# Older reviews pin these pre-repair readers; retain exact historical bytes as
# transformed copies instead of silently resolving their SHA to today's reader.
HISTORICAL_VERSIONS = {
    "473ce4838efb682cc60ed89b37b9c411fbd33c503d44dd187a580eb38ba7ef28": SOURCE / "windows-ci-tools/git-launch-controls-reader-repair-r1/before-read_git_launch_controls.py",
    "b2ef16b086e12f98048c4c4279b556a4101111952cf3b67fa8b8409e463b74e5": SOURCE / "windows-ci-tools/git-launch-controls-reader-repair-r1/before-test_read_git_launch_controls.py",
    "4102052b26feca35e2eab6e1a4e0b591ec9069695241c03efe1e94fb106ec4af": SOURCE / "windows-ci-tools/focused-native-reader-r4-originals/read_focused_native.py",
}
for sha, p in HISTORICAL_VERSIONS.items():
    assert digest_file(p) == sha, "Historical reader version changed"
    selection.add(p)
# One extra dependency hop for direct reports only; the catalog explicitly marks
# further history as local. This never recursively imports all older evidence.
direct_reports = [p for p in selection if p.suffix == ".json" and not protected(p) and "windows-ci-" not in rel(p)]
for p in direct_reports:
    selection.update(q for q in references(load_json(p)) if q.is_file() and q.suffix in text_exts and not protected(q))

catalog = {}
receipt_hashes = collections.defaultdict(set)


def collect_receipt_hashes(value):
    if isinstance(value, dict):
        p = exact_path(value.get("path", "")) if isinstance(value.get("path"), str) else None
        sha = value.get("sha256")
        if p and isinstance(sha, str) and re.fullmatch("[0-9a-f]{64}", sha):
            receipt_hashes[p].add(sha)
        for x in value.values():
            collect_receipt_hashes(x)
    elif isinstance(value, list):
        for x in value:
            collect_receipt_hashes(x)


for p in sorted(selection):
    if p.suffix == ".json" and not protected(p):
        data = load_json(p)
        collect_receipt_hashes(data)
        for q in references(data):
            catalog.setdefault(q, {})
    catalog.setdefault(p, {})

for p, entry in catalog.items():
    reason = protected(p)
    included = p in selection and p.is_file() and not reason
    entry.update({"id": eid(p), "sourcePath": rel(p), "publication": "published-copy" if included else "local-retained", "existsAtPreservation": p.exists(), "pathKind": "directory" if p.is_dir() else "file" if p.is_file() else "missing"})
    if p.is_file():
        entry["originalBytes"] = p.stat().st_size
        # Never open protected database, sidecar, complete data manifest, UI, or
        # binary source. Use only already recorded hashes for those files.
        if reason:
            entry["originalSha256FromReceipts"] = sorted(receipt_hashes[p])
            entry["originalContentsRead"] = False
        else:
            entry["originalSha256"] = digest_file(p)
    if receipt_hashes[p]:
        entry["referencedOriginalSha256"] = sorted(receipt_hashes[p])
    if reason or not included:
        entry["localRetentionReason"] = reason or "outside bounded publication selection; preserved in original local evidence"
    if included:
        sub = p.relative_to(SOURCE) if p.is_relative_to(SOURCE) else Path("receipts") / p.name
        entry["publishedPath"] = rel(DEST / sub)

changes = collections.Counter()


def opaque(kind, value):
    return f"<{kind}:{digest_bytes(value.encode())[:12]}>"


def sanitize_text(text):
    # A repository path remains useful and discloses no user home prefix.
    count = text.count(str(REPO) + "/")
    changes["repository-home-prefix-removed"] += count
    text = text.replace(str(REPO) + "/", "")
    # Windows CI homes are ephemeral runner profiles, nevertheless remove the
    # account name and full local path from published diagnostics.
    patterns = [
        ("private-mac-home", r"/Users/[^\s\"'<>\r\n,;\]\)]+"),
        ("private-mac-temp", r"/(?:private/)?(?:var/folders|tmp)/[^\s\"'<>\r\n,;\]\)]+"),
        ("windows-user-path", r"(?i)[a-z]:\\(?:\\)?Users\\(?:\\)?[^\s\"'<>\r\n,;\]\)]+"),
        ("email", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
        ("credential-token", r"(?:sk-[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})"),
    ]
    for label, pattern in patterns:
        def replace(match):
            changes[label] += 1
            return opaque(label, match.group())
        text = re.sub(pattern, replace, text)
    return text


def sanitize(value, key=""):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "path" and isinstance(v, str) and value.get("sha256") in HISTORICAL_VERSIONS:
                changes["historical-version-reference-resolved"] += 1
                out[k] = "evidence:" + catalog[HISTORICAL_VERSIONS[value["sha256"]]]["id"]
            elif k in {"processObservations", "formalProcessesAtObservation", "normalQuitEvidence"}:
                changes["private-process-or-ui-subtree-omitted"] += 1
                out[k] = {"publication": "omitted-private-context", "originalRetainedLocally": True}
            elif k in {"sessionId", "native_session_id", "session_id", "sessionTitle"}:
                changes["session-identifier-omitted"] += 1
                out[k] = "<session-identifier-omitted>"
            else:
                out[sanitize_text(k)] = sanitize(v, k)
        return out
    if isinstance(value, list):
        return [sanitize(x, key) for x in value]
    if isinstance(value, str):
        q = exact_path(value)
        if q is not None and q in catalog:
            changes["evidence-reference-mapped"] += 1
            return "evidence:" + catalog[q]["id"]
        return sanitize_text(value)
    return value


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    # Static formatting of new artifacts only. This is not a historical check.
    result = subprocess.run(["corepack", "pnpm", "exec", "prettier", "--stdin-filepath", rel(path)], input=text, text=True, cwd=REPO, capture_output=True, check=True)
    path.write_text(result.stdout)


published = []
for p, entry in sorted(catalog.items()):
    if entry["publication"] != "published-copy":
        continue
    target = REPO / entry["publishedPath"]
    source_text = p.read_text(encoding="utf-8-sig")
    if p.suffix == ".json":
        out = json.dumps(sanitize(json.loads(source_text)), ensure_ascii=False, indent=2) + "\n"
    elif p.suffix == ".jsonl":
        out = "\n".join(json.dumps(sanitize(json.loads(line)), ensure_ascii=False) for line in source_text.splitlines() if line.strip()) + "\n"
    else:
        out = sanitize_text(source_text)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(out)
    entry["publishedSha256"] = digest_file(target)
    entry["publishedBytes"] = target.stat().st_size
    entry["transformation"] = "UTF-8 text/JSON copy; home/temp paths and emails/token patterns replaced; private process/UI subtrees omitted; exact selected evidence paths mapped to catalog IDs"
    published.append(target)

json_copies = [p for p in published if p.suffix == ".json"]
subprocess.run(["corepack", "pnpm", "exec", "prettier", "--write", *map(rel, json_copies)], cwd=REPO, capture_output=True, check=True)
for entry in catalog.values():
    if entry["publication"] == "published-copy":
        target = REPO / entry["publishedPath"]
        entry["publishedSha256"] = digest_file(target)
        entry["publishedBytes"] = target.stat().st_size

raw_integrity = []
for run in RAW_RUNS:
    raw_root = SOURCE / f"windows-ci-{run}-1"
    files = [p for p in raw_root.rglob("*") if p.is_file()]
    download = SOURCE / "windows-ci-tools" / f"download-{run}-attempt1-r1.json"
    receipt = load_json(download)
    expected = receipt.get("files", {})
    mismatch = []
    if isinstance(expected, dict):
        for name, spec in expected.items():
            p = raw_root / name
            sha = spec.get("sha256") if isinstance(spec, dict) else None
            if not p.is_file() or (sha and digest_file(p) != sha):
                mismatch.append(name)
    raw_integrity.append({"runId": int(run), "files": len(files), "originalBytes": sum(p.stat().st_size for p in files), "publishedCopies": sum(catalog[p]["publication"] == "published-copy" for p in files), "downloadReceiptFileMapEntries": len(expected), "downloadMapMismatches": mismatch})

scan_patterns = {
    "mac-home": r"/Users/[^\s/]+/",
    "mac-temp": r"/(?:private/)?var/folders/",
    "windows-user-path": r"(?i)[a-z]:\\(?:\\)?Users\\",
    "email": r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}",
    "credential-token": r"(?:sk-[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})",
}
findings = []
for path in published:
    text = path.read_text()
    for label, pattern in scan_patterns.items():
        n = len(re.findall(pattern, text))
        if n:
            findings.append({"path": rel(path), "kind": label, "count": n})

catalog_path = DEST / "catalog.json"
write_json(catalog_path, {"schema": 1, "kind": "bounded preservation catalog; original hashes differ from transformed copy hashes", "referenceSyntax": "evidence:<id> resolves to entries[].id; local-retained entries intentionally have no Git copy", "entries": list(catalog.values())})
published.append(catalog_path)
report_path = MAINT / "stage-privacy-and-integrity.json"
write_json(report_path, {"schema": 1, "sourceRoots": [rel(DOCS / n) for n in ROOT_NAMES], "originalsChanged": False, "historicalCommandsRerun": False, "applicationOrAgentStarted": False, "databasesOrCompleteUserManifestsOpened": False, "scope": "direct receipt dependencies; current r12/e616 directories; one bounded report dependency hop; three raw CI cohorts", "publishedFilesIncludingCatalog": len(published), "publishedBytesIncludingCatalog": sum(p.stat().st_size for p in published), "localOnlyReferences": sum(e["publication"] == "local-retained" for e in catalog.values()), "transformations": dict(changes), "rawCiIntegrity": raw_integrity, "residualPatternFindings": findings, "historicalMutablePathVersions": [{"sha256": sha, "exactRetainedOriginalPath": rel(p), "publishedCopyPath": catalog[p]["publishedPath"]} for sha, p in HISTORICAL_VERSIONS.items()], "missingCatalogSources": [e["sourcePath"] for e in catalog.values() if not e["existsAtPreservation"]], "privacyLimits": ["Pattern checks and structural exclusion do not prove universal secret absence.", "Controlled CI raw logs and reports are transformed copies; use original SHA-256 values to verify local originals and published SHA-256 values for copies.", "Accessibility trees, screenshots, process arguments, user data manifests, databases and sidecars remain local; protected contents were not opened by this preservation script.", "Only selected current-stage evidence is published, not the complete transitive historical record.", "No new product acceptance or test success is claimed; historical failures and unresolved unknown-writer observations remain."]})
published.append(report_path)
if findings or any(x["downloadMapMismatches"] for x in raw_integrity):
    raise SystemExit("Privacy or CI source integrity review required; inspect report metadata only")
allowlist = MAINT / "stage-add-allowlist.json"
files = published + [Path(__file__).resolve()]
readme = DEST / "README.md"
if readme.is_file():
    files.append(readme)
write_json(allowlist, {"schema": 1, "scope": "stage evidence publication only; exact Git-add whitelist", "selfPath": rel(allowlist), "files": [{"path": rel(p), "bytes": p.stat().st_size, "sha256": digest_file(p)} for p in sorted(files)]})
print(json.dumps({"publishedFiles": len(published), "publishedBytes": sum(p.stat().st_size for p in published), "localOnlyReferences": sum(e["publication"] == "local-retained" for e in catalog.values()), "rawCiIntegrity": raw_integrity, "residualFindings": len(findings), "allowlist": rel(allowlist)}, ensure_ascii=False))
