import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath =
  "docs/archive/2026-10-17-documentation-alignment/plan-conditions.json";
const baselineSha256 =
  "a5c231d101131af806b95ba174be1a7f6a360ae650912623b963a40159472b7e";
const entrypoints = [
  "AGENTS.md",
  "PRODUCT.md",
  "README.md",
  "INTERNAL-USE.md",
  "docs/README.md",
  "docs/status.md",
  "docs/architecture.md",
  "docs/archive/README.md",
  "docs/archive/2026-10-17-documentation-alignment/INDEX.md",
  "plans/agent-access.md",
  ".design/README.md",
  ".design/2026-09-26-agent-access-redesign/workbench/README.md",
];

// Progress is deliberately not part of an original completion condition.
// NEW issue descriptions use three columns; the original audit uses four.
export function verifyPlan(text, baseline) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*(?:ARCH-\d+|NEW-\d+|P\d+|H\d+)\s*\|/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    assert.ok([3, 4].includes(cells.length), "unexpected plan row shape");
    const id = cells[0];
    assert.ok(!rows.has(id), `duplicate plan ID: ${id}`);
    rows.set(id, { title: cells[1], completion: cells.at(-1) });
  }
  assert.equal(Object.keys(baseline.rows).length, baseline.originalCount);
  for (const [id, condition] of Object.entries(baseline.rows))
    assert.deepEqual(
      rows.get(id),
      condition,
      `original condition changed: ${id}`,
    );
  return { originalConditions: baseline.originalCount, currentRows: rows.size };
}

function headingIds(text) {
  const ids = new Set();
  const counts = new Map();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const match = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    let count = counts.get(base) ?? 0;
    let id = count ? `${base}-${count}` : base;
    while (ids.has(id)) {
      count++;
      id = `${base}-${count}`;
    }
    counts.set(base, count + 1);
    ids.add(id);
  }
  return ids;
}

export function verifyLinks(text, file) {
  let links = 0;
  let anchors = 0;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const [rawPath, rawAnchor] = target.split("#", 2);
      const path = decodeURIComponent(rawPath);
      const destination = path
        ? resolve(dirname(resolve(root, file)), path)
        : resolve(root, file);
      assert.ok(
        existsSync(destination),
        `missing local link in ${file}: ${path}`,
      );
      if (rawAnchor && destination.endsWith(".md")) {
        assert.ok(
          headingIds(readFileSync(destination, "utf8")).has(
            decodeURIComponent(rawAnchor),
          ),
          `missing heading in ${file}: ${target}`,
        );
        anchors++;
      }
      links++;
    }
  }
  return { links, anchors };
}

export function checkProjectDocs() {
  const raw = readFileSync(resolve(root, baselinePath));
  assert.equal(createHash("sha256").update(raw).digest("hex"), baselineSha256);
  const plans = readdirSync(resolve(root, "plans")).filter((name) =>
    name.endsWith(".md"),
  );
  assert.deepEqual(plans, ["agent-access.md"], "keep one active Markdown plan");
  const plan = verifyPlan(
    readFileSync(resolve(root, "plans/agent-access.md"), "utf8"),
    JSON.parse(raw),
  );
  let localLinks = 0;
  let localAnchors = 0;
  for (const file of entrypoints) {
    const result = verifyLinks(readFileSync(resolve(root, file), "utf8"), file);
    localLinks += result.links;
    localAnchors += result.anchors;
  }
  return {
    ...plan,
    activePlans: plans.length,
    entrypoints: entrypoints.length,
    localLinks,
    localAnchors,
    progressFrozen: false,
    productAcceptanceClaimed: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(checkProjectDocs()));
