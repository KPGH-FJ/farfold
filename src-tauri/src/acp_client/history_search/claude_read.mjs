// Fixed official SDK history reader. No query/resume/configuration calls.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const ADAPTER = "@agentclientprotocol/claude-agent-acp";
const SDK = "@anthropic-ai/claude-agent-sdk";
export class ReadFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function fail(code) {
  throw new ReadFailure(code);
}
const inside = (root, value) =>
  value === root || value.startsWith(root + path.sep);
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
async function regular(file) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) fail("entryUnverified");
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}
async function manifest(file) {
  const stamp = await regular(file);
  if (stamp.size > 65536) fail("entryUnverified");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!plain(value)) fail("entryUnverified");
  return { value, file, stamp };
}
async function namedPackage(entry, root, name) {
  let dir = path.dirname(entry);
  for (let depth = 0; depth < 8 && inside(root, dir); depth++) {
    let found;
    try {
      found = await manifest(path.join(dir, "package.json"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (found) {
      if (found.value.name !== name) fail("entryUnverified");
      return { ...found, dir };
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  fail("entryUnverified");
}
export async function resolveSelected(launch) {
  try {
    if (
      !plain(launch) ||
      Object.keys(launch).sort().join() !== "entry,installationRoot,node" ||
      ![launch.entry, launch.installationRoot, launch.node].every(
        (v) => typeof v === "string" && path.isAbsolute(v),
      )
    )
      fail("invalidRequest");
    const root = await fs.realpath(launch.installationRoot);
    const entry = await fs.realpath(launch.entry);
    const node = await fs.realpath(launch.node);
    if (!inside(root, entry)) fail("entryUnverified");
    await regular(node);
    await regular(entry);
    const adapter = await namedPackage(entry, root, ADAPTER);
    const bin = adapter.value.bin?.["claude-agent-acp"];
    if (
      typeof bin !== "string" ||
      !plain(adapter.value.dependencies) ||
      typeof adapter.value.dependencies[SDK] !== "string" ||
      (await fs.realpath(path.resolve(adapter.dir, bin))) !== entry
    )
      fail("entryUnverified");
    // resolve() obtains a filename; it does not evaluate the package.
    const sdkEntry = await fs.realpath(createRequire(entry).resolve(SDK));
    if (!inside(root, sdkEntry)) fail("entryUnverified");
    const sdk = await namedPackage(sdkEntry, root, SDK);
    const declared = sdk.value.exports?.["."];
    if (
      !plain(declared) ||
      Object.keys(declared).some((k) => k !== "default" && k !== "types") ||
      typeof declared.default !== "string" ||
      sdk.value.type !== "module" ||
      !declared.default.startsWith("./") ||
      (await fs.realpath(path.resolve(sdk.dir, declared.default))) !== sdkEntry
    )
      fail("entryUnverified");
    const sdkStamp = await regular(sdkEntry);
    return {
      node,
      entry,
      sdkEntry,
      root,
      watched: [
        { file: entry, stamp: await regular(entry) },
        { file: adapter.file, stamp: adapter.stamp },
        { file: sdk.file, stamp: sdk.stamp },
        { file: sdkEntry, stamp: sdkStamp },
      ],
    };
  } catch (e) {
    if (e instanceof ReadFailure) throw e;
    fail("entryUnverified");
  }
}
export async function recheckResolved(resolved) {
  try {
    for (const item of resolved.watched) {
      if (
        !inside(resolved.root, await fs.realpath(item.file)) ||
        JSON.stringify(await regular(item.file)) !== JSON.stringify(item.stamp)
      )
        fail("selectionChanged");
    }
  } catch {
    fail("selectionChanged");
  }
}

export const READ_SCOPE = Object.freeze({
  kind: "officialSdk",
  relation: "registeredExactId",
  coverage: "partial",
  continuation: "unverified",
  branch: "unverified",
});
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const safeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const validText = (value) =>
  typeof value === "string" &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
export const LIMITS = Object.freeze({
  messages: 400,
  blocks: 1600,
  inputFileBytes: 8388608,
  projectedBytes: 1048576,
  blockBytes: 65536,
});

export function validateRequest(value) {
  if (
    !plain(value) ||
    Object.keys(value).sort().join() !== "cwd,rowId,sessionId" ||
    !uuid(value.sessionId) ||
    !validText(value.rowId) ||
    value.rowId.length < 1 ||
    value.rowId.length > 1024 ||
    !validText(value.cwd) ||
    !value.cwd.startsWith("/") ||
    value.cwd.includes("\0") ||
    value.cwd.length > 4096
  )
    fail("invalidRequest");
  return value;
}
export async function checkedInfo(value, request, canonicalize) {
  if (!plain(value)) fail("sourceUnconfirmed");
  if (value.sessionId !== request.sessionId || typeof value.cwd !== "string")
    fail("sourceUnconfirmed");
  let reported;
  try {
    reported = await canonicalize(value.cwd);
  } catch {
    fail("sourceUnconfirmed");
  }
  if (
    reported !== request.cwd ||
    !safeInt(value.lastModified) ||
    !safeInt(value.fileSize)
  )
    fail("sourceUnconfirmed");
  if (value.fileSize > LIMITS.inputFileBytes) fail("sourceTooLarge");
  return {
    sessionId: value.sessionId,
    cwd: reported,
    lastModified: value.lastModified,
    fileSize: value.fileSize,
  };
}
function boundedText(text, bytes) {
  // Preserve original characters and UTF-16 boundaries; matching belongs in Rust.
  let out = "",
    size = 0;
  for (const char of text) {
    const length = Buffer.byteLength(char);
    if (size + length > bytes) break;
    out += char;
    size += length;
  }
  return { text: out, bytes: size, truncated: out.length !== text.length };
}
export function project(messages, request) {
  if (!Array.isArray(messages) || messages.length === 0)
    fail("sourceUnconfirmed");
  if (messages.length > LIMITS.messages + 1) fail("invalidOutput");
  const ids = new Set(),
    blocks = [];
  let used = 0,
    limited = messages.length > LIMITS.messages;
  for (const record of messages.slice(0, LIMITS.messages)) {
    if (
      !plain(record) ||
      !uuid(record.uuid) ||
      ids.has(record.uuid) ||
      record.session_id !== request.sessionId ||
      !["user", "assistant"].includes(record.type) ||
      !plain(record.message) ||
      record.message.role !== record.type ||
      record.parent_tool_use_id !== null ||
      record.parent_agent_id !== null
    )
      fail("invalidOutput");
    const known = new Set([
      "type",
      "uuid",
      "session_id",
      "message",
      "parent_tool_use_id",
      "parent_agent_id",
      "interruptedByShutdown",
      "isCompactSummary",
      "is_meta",
      "isQueuedCommand",
      "isCompletedLocalCommand",
      "timestamp",
      "origin",
    ]);
    if (Object.keys(record).some((key) => !known.has(key)))
      fail("invalidOutput");
    ids.add(record.uuid);
    for (const field of [
      "is_meta",
      "isCompactSummary",
      "isQueuedCommand",
      "isCompletedLocalCommand",
      "interruptedByShutdown",
    ]) {
      if (record[field] !== undefined && typeof record[field] !== "boolean")
        fail("invalidOutput");
    }
    // The public SDK can expose compaction summaries as user records with these
    // flags. Preserve the limited scope instead of presenting generated summary
    // text as an original user/assistant text block.
    if (
      record.is_meta === true ||
      record.isCompactSummary === true ||
      record.isQueuedCommand === true ||
      record.isCompletedLocalCommand === true
    )
      continue;
    // The public wrapper preserves task/other origins. Without proof these are
    // original main-conversation prose, omit them rather than relabel as user.
    if (record.origin !== undefined && record.origin !== null) {
      if (!plain(record.origin) || typeof record.origin.kind !== "string")
        fail("invalidOutput");
      continue;
    }
    const content = record.message.content;
    const parts =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(parts)) fail("invalidOutput");
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      if (!plain(part) || typeof part.type !== "string") fail("invalidOutput");
      if (part.type !== "text") continue;
      if (!validText(part.text)) fail("invalidOutput");
      if (blocks.length >= LIMITS.blocks || used >= LIMITS.projectedBytes) {
        limited = true;
        continue;
      }
      const chunk = boundedText(
        part.text,
        Math.min(LIMITS.blockBytes, LIMITS.projectedBytes - used),
      );
      used += chunk.bytes;
      limited ||= chunk.truncated;
      blocks.push({
        rowId: request.rowId,
        messageLocator: { kind: "message", messageId: record.uuid, partIndex },
        role: record.type,
        text: chunk.text,
        textTruncated: chunk.truncated,
      });
    }
  }
  if (blocks.length === 0) fail("sourceUnconfirmed");
  return {
    checkedOfficialSource: READ_SCOPE,
    coverage: "partial",
    code: "coverageUnconfirmed",
    limited,
    blocks,
  };
}
export async function readProjection(
  sdk,
  input,
  canonicalize,
  within = () => {},
) {
  const request = validateRequest(input);
  try {
    within();
    if (
      typeof sdk?.getSessionInfo !== "function" ||
      typeof sdk?.getSessionMessages !== "function"
    )
      fail("unsupported");
    const cwd = await canonicalize(request.cwd);
    if (cwd !== request.cwd) fail("sourceUnconfirmed");
    const before = await checkedInfo(
      await sdk.getSessionInfo(request.sessionId, { dir: request.cwd }),
      request,
      canonicalize,
    );
    within();
    const records = await sdk.getSessionMessages(request.sessionId, {
      dir: request.cwd,
      offset: 0,
      limit: LIMITS.messages + 1,
      includeSystemMessages: false,
    });
    within();
    const after = await checkedInfo(
      await sdk.getSessionInfo(request.sessionId, { dir: request.cwd }),
      request,
      canonicalize,
    );
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("sourceChanged");
    within();
    return project(records, request);
  } catch (e) {
    if (e instanceof ReadFailure) throw e;
    // Never expose a SDK exception, path, query, configuration or raw response.
    fail("queryFailed");
  }
}
// The parent owns deadlines, cancellation, process group and pipe cleanup.
import { pathToFileURL } from "node:url";

export async function execute(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== "expectedSdkEntry,launch,request"
  )
    fail("invalidRequest");
  validateRequest(input.request); // No import on an invalid request.
  const resolved = await resolveSelected(input.launch);
  if (resolved.sdkEntry !== input.expectedSdkEntry) fail("selectionChanged");
  if ((await fs.realpath(process.execPath)) !== resolved.node)
    fail("entryUnverified");
  await recheckResolved(resolved);
  // SDK code runs only after selected-installation resolution. Parent supplies
  // process isolation, deadline/cancellation and true group+pipe cleanup.
  const sdk = await import(pathToFileURL(resolved.sdkEntry).href);
  const projection = await readProjection(sdk, input.request, (file) =>
    fs.realpath(file),
  );
  await recheckResolved(resolved);
  return { kind: "projection", ...projection };
}
async function main() {
  let chunks = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      chunks = Buffer.concat([chunks, chunk]);
      if (chunks.length > 32768) fail("invalidRequest");
      const end = chunks.indexOf(10);
      if (end >= 0) {
        if (end !== chunks.length - 1) fail("invalidRequest");
        break;
      }
    }
    let input;
    try {
      input = JSON.parse(chunks.toString("utf8"));
    } catch {
      fail("invalidRequest");
    }
    chunks.fill(0);
    const value = await execute(input);
    const body = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(body) > 8388608) fail("outputLimit");
    process.stdout.write(body);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        kind: "error",
        code: e instanceof ReadFailure ? e.code : "queryFailed",
      }) + "\n",
    );
  }
}
if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
