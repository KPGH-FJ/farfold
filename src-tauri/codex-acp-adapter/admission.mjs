// Fixed 0.143.0 account/catalog evidence, never credential or managed verification.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const check = (ok) => {
  if (!ok) throw Error("Native admission evidence unavailable");
};
export const identity = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
const text = (v, n = 4096) =>
  typeof v === "string" && v.length <= n && !v.includes("\0");
const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const same = isDeepStrictEqual;
export function model(value) {
  check(
    value &&
      identity(value.id) &&
      identity(value.model) &&
      text(value.displayName) &&
      text(value.description) &&
      typeof value.hidden === "boolean" &&
      typeof value.isDefault === "boolean" &&
      identity(value.defaultReasoningEffort) &&
      Array.isArray(value.supportedReasoningEfforts) &&
      value.supportedReasoningEfforts.length > 0 &&
      value.supportedReasoningEfforts.length <= 32 &&
      Array.isArray(value.inputModalities) &&
      value.inputModalities.length > 0 &&
      value.inputModalities.length <= 2 &&
      value.inputModalities.every((v) => ["text", "image"].includes(v)) &&
      new Set(value.inputModalities).size === value.inputModalities.length,
  );
  const efforts = value.supportedReasoningEfforts.map((e) => {
    check(identity(e.reasoningEffort) && text(e.description));
    return { reasoningEffort: e.reasoningEffort, description: e.description };
  });
  check(
    new Set(efforts.map((e) => e.reasoningEffort)).size === efforts.length &&
      efforts.some((e) => e.reasoningEffort === value.defaultReasoningEffort),
  );
  return {
    id: value.id,
    model: value.model,
    displayName: value.displayName,
    description: value.description,
    hidden: value.hidden,
    isDefault: value.isDefault,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: value.defaultReasoningEffort,
    inputModalities: [...value.inputModalities],
  };
}
export function createAdmission({ request, retain, launch, enabled = false }) {
  let epoch = 1,
    account = null,
    accountHash = null,
    catalog = null,
    catalogHash = null;
  let selection = null,
    actual = null,
    fresh = false;
  function invalidate() {
    epoch++;
    fresh = false;
    selection = null;
  }
  function observe(frame) {
    if (frame.method?.startsWith("account/")) {
      invalidate();
      return;
    }
    if (
      frame.method === "thread/settings/updated" &&
      actual &&
      frame.params?.threadId === actual.nativeThreadId
    ) {
      const s = frame.params.threadSettings;
      if (
        s?.cwd !== launch.cwd ||
        s?.model !== actual.nativeModel ||
        s?.modelProvider !== actual.provider ||
        s?.effort !== actual.reasoningEffort ||
        s?.collaborationMode?.settings?.model !== actual.nativeModel ||
        s?.collaborationMode?.settings?.reasoning_effort !==
          actual.reasoningEffort
      ) {
        actual = null; // A new choice cannot revive an invalidated native config snapshot.
        invalidate();
      }
    }
  }
  async function refresh() {
    check(enabled);
    fresh = false;
    const before = epoch;
    const rawAccount = await request("account/read", { refreshToken: false });
    retain(rawAccount);
    check(
      typeof rawAccount?.requiresOpenaiAuth === "boolean" &&
        (rawAccount.account === null ||
          ["apiKey", "chatgpt", "amazonBedrock"].includes(
            rawAccount.account?.type,
          )),
    );
    // Full account identity stays private; changing accounts of the same type invalidates selection.
    const kind = rawAccount.account?.type ?? "unauthenticated";
    if (kind === "amazonBedrock")
      check(
        ["codexManaged", "awsManaged"].includes(
          rawAccount.account.credentialSource,
        ),
      );
    if (kind === "chatgpt")
      check(
        (rawAccount.account.email === null || text(rawAccount.account.email)) &&
          [
            "free",
            "go",
            "plus",
            "pro",
            "prolite",
            "team",
            "self_serve_business_usage_based",
            "business",
            "enterprise_cbp_usage_based",
            "enterprise",
            "edu",
            "unknown",
          ].includes(rawAccount.account.planType),
      );
    const hash = digest(rawAccount);
    const data = [],
      cursors = new Set(),
      ids = new Set();
    let cursor = null,
      finished = false;
    for (let page = 0; page < 16; page++) {
      const raw = await request("model/list", {
        cursor,
        limit: 32,
        includeHidden: true,
      });
      retain(raw);
      check(
        Array.isArray(raw?.data) &&
          raw.data.length <= 32 &&
          (raw.nextCursor === null ||
            (text(raw.nextCursor, 1024) && raw.nextCursor.length > 0)),
      );
      for (const v of raw.data) {
        const m = model(v);
        check(!ids.has(m.id));
        ids.add(m.id);
        data.push(m);
      }
      check(Buffer.byteLength(JSON.stringify(data)) <= 262144);
      if (raw.nextCursor === null) {
        finished = true;
        break;
      }
      check(raw.data.length > 0 && !cursors.has(raw.nextCursor));
      cursors.add(raw.nextCursor);
      cursor = raw.nextCursor;
    }
    check(finished && epoch === before);
    const nextHash = digest(data);
    if (accountHash !== hash || catalogHash !== nextHash) invalidate();
    account = { kind, requiresOpenaiAuth: rawAccount.requiresOpenaiAuth };
    accountHash = hash;
    catalog = data;
    catalogHash = nextHash;
    fresh = true;
    return snapshot();
  }
  function selected(s) {
    check(
      fresh &&
        account?.kind !== "unauthenticated" &&
        s &&
        identity(s.catalogModelId) &&
        identity(s.nativeModel) &&
        identity(s.provider) &&
        identity(s.reasoningEffort),
    );
    const m = catalog?.find((m) => m.id === s.catalogModelId);
    check(
      m &&
        !m.hidden &&
        m.model === s.nativeModel &&
        m.inputModalities.includes("text") &&
        m.supportedReasoningEfforts.some(
          (e) => e.reasoningEffort === s.reasoningEffort,
        ),
    );
    return m;
  }
  function choose(c) {
    check(
      enabled &&
        same(c.observationScope, launch.scope) &&
        c.epoch === epoch &&
        c.catalogHash === catalogHash,
    );
    const m = catalog?.find((m) => m.id === c.catalogModelId);
    const s = {
      catalogModelId: c.catalogModelId,
      nativeModel: m?.model,
      provider: c.provider,
      reasoningEffort: c.reasoningEffort,
    };
    selected(s);
    if (actual)
      check(
        actual.nativeModel === s.nativeModel &&
          actual.provider === s.provider &&
          actual.reasoningEffort === s.reasoningEffort,
      );
    selection = s;
    return snapshot();
  }
  function snapshot() {
    return {
      scope: launch.scope,
      epoch,
      account: fresh ? account : null,
      catalog: fresh ? catalog : null,
      catalogHash: fresh ? catalogHash : null,
      selection: fresh ? selection : null,
      actual,
    };
  }
  async function beforeStart() {
    const expected = selection;
    await refresh();
    selected(selection);
    check(same(expected, selection));
    return {
      model: selection.nativeModel,
      modelProvider: selection.provider,
      allowProviderModelFallback: false,
      config: { model_reasoning_effort: selection.reasoningEffort },
    };
  }
  function confirm(raw, thread, expected = selection) {
    selected(expected);
    check(
      raw.model === expected.nativeModel &&
        raw.modelProvider === expected.provider &&
        raw.reasoningEffort === expected.reasoningEffort &&
        raw.thread.modelProvider === expected.provider &&
        raw.cwd === launch.cwd &&
        raw.thread.status.type === "idle",
    );
    actual = {
      ...expected,
      nativeThreadId: thread.nativeThreadId,
      nativeSessionId: thread.nativeSessionId,
    };
    selection = { ...expected };
  }
  async function prepare(expected, read) {
    check(enabled && actual && selection);
    const previous = snapshot();
    await refresh();
    selected(selection);
    check(same(previous.selection, selection) && same(previous.actual, actual));
    check(
      expected.nativeThreadId === actual.nativeThreadId &&
        expected.nativeSessionId === actual.nativeSessionId,
    );
    const raw = await read();
    check(
      raw.thread.status.type === "idle" &&
        raw.thread.modelProvider === actual.provider,
    );
    // Read has no model/effort fields. The original loaded start/resume snapshot is used.
    check(fresh && previous.epoch === epoch);
    return snapshot();
  }
  function ticket(c) {
    check(fresh && same(c, snapshot()) && selection && actual);
  }
  return {
    refresh,
    choose,
    snapshot,
    observe,
    invalidate,
    beforeStart,
    confirm,
    prepare,
    ticket,
    restore: (s) => {
      selected(s);
      selection = { ...s };
    },
    requireSelection: () => selected(selection),
    enabled,
  };
}
