// Fixed 0.143.0 server-request codec. Full envelopes remain in the private channel.
import { isDeepStrictEqual } from "node:util";
export const supported = (m) =>
  [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
  ].includes(m);
export const id = (v) =>
  (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v)) ||
  Number.isSafeInteger(v);
const str = (v, max = 16384) =>
  typeof v === "string" && Buffer.byteLength(v) <= max;
const check = (v) => {
  if (!v) throw Error("Native interaction outside fixed contract");
};
const keys = (v, allowed) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k));
const nullable = (v, validate) => v == null || validate(v);
const array = (v, validate, max = 128) =>
  Array.isArray(v) && v.length <= max && v.every((x) => validate(x));
const rule = (v) =>
  keys(v, ["host", "action"]) &&
  str(v.host, 4096) &&
  ["allow", "deny"].includes(v.action);
export function decision(v) {
  if (typeof v === "string")
    return ["accept", "acceptForSession", "decline", "cancel"].includes(v);
  if (
    !keys(v, [
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
    ]) ||
    Object.keys(v).length !== 1
  )
    return false;
  return v.acceptWithExecpolicyAmendment
    ? keys(v.acceptWithExecpolicyAmendment, ["execpolicy_amendment"]) &&
        array(
          v.acceptWithExecpolicyAmendment.execpolicy_amendment,
          (s) => str(s) && !!s,
        ) &&
        v.acceptWithExecpolicyAmendment.execpolicy_amendment.length > 0
    : keys(v.applyNetworkPolicyAmendment, ["network_policy_amendment"]) &&
        rule(v.applyNetworkPolicyAmendment.network_policy_amendment);
}
function fsPath(v) {
  if (!keys(v, ["type", "path", "pattern", "value"])) return false;
  if (v.type === "path") return Object.keys(v).length === 2 && str(v.path);
  if (v.type === "glob_pattern")
    return Object.keys(v).length === 2 && str(v.pattern);
  const s = v.value;
  return (
    v.type === "special" &&
    Object.keys(v).length === 2 &&
    keys(s, ["kind", "path", "subpath"]) &&
    (["root", "minimal", "tmpdir", "slash_tmp"].includes(s.kind)
      ? Object.keys(s).length === 1
      : s.kind === "project_roots"
        ? Object.keys(s).length === 2 && nullable(s.subpath, str)
        : s.kind === "unknown" &&
          Object.keys(s).length === 3 &&
          str(s.path) &&
          nullable(s.subpath, str))
  );
}
function permissions(v) {
  return (
    keys(v, ["network", "fileSystem"]) &&
    nullable(
      v.network,
      (n) =>
        keys(n, ["enabled"]) &&
        (n.enabled === null || typeof n.enabled === "boolean"),
    ) &&
    nullable(
      v.fileSystem,
      (f) =>
        keys(f, ["read", "write", "globScanMaxDepth", "entries"]) &&
        nullable(f.read, (p) => array(p, str)) &&
        nullable(f.write, (p) => array(p, str)) &&
        (f.globScanMaxDepth === undefined ||
          (Number.isSafeInteger(f.globScanMaxDepth) &&
            f.globScanMaxDepth >= 0)) &&
        (f.entries === undefined ||
          array(
            f.entries,
            (e) =>
              keys(e, ["path", "access"]) &&
              fsPath(e.path) &&
              ["read", "write", "deny"].includes(e.access),
          )),
    )
  );
}
export function projectRequest(frame, mode) {
  check(supported(frame.method) && id(frame.id));
  const p = frame.params;
  check(
    p &&
      [p.threadId, p.turnId, p.itemId].every(
        (v) => typeof v === "string" && id(v),
      ),
  );
  const out = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId };
  if (frame.method === "item/tool/requestUserInput") {
    check(
      mode === "plan" &&
        array(
          p.questions,
          (q) =>
            keys(q, [
              "id",
              "header",
              "question",
              "isOther",
              "isSecret",
              "options",
            ]) &&
            typeof q.id === "string" &&
            id(q.id) &&
            str(q.header, 1024) &&
            str(q.question) &&
            !!q.question &&
            typeof q.isOther === "boolean" &&
            typeof q.isSecret === "boolean" &&
            (q.options === null ||
              array(
                q.options,
                (o) =>
                  keys(o, ["label", "description"]) &&
                  str(o.label) &&
                  !!o.label &&
                  str(o.description),
                32,
              )),
          16,
        ) &&
        p.questions.length > 0 &&
        new Set(p.questions.map((q) => q.id)).size === p.questions.length &&
        (p.autoResolutionMs === null ||
          (Number.isSafeInteger(p.autoResolutionMs) &&
            p.autoResolutionMs > 0 &&
            p.autoResolutionMs <= 300000)),
    );
    out.questions = p.questions;
    out.autoResolutionMs = p.autoResolutionMs;
  } else {
    check(Number.isSafeInteger(p.startedAtMs) && p.startedAtMs >= 0);
    out.startedAtMs = p.startedAtMs;
    for (const field of frame.method === "item/fileChange/requestApproval"
      ? ["reason", "grantRoot"]
      : ["reason", "command", "cwd", "approvalId", "environmentId"]) {
      if (p[field] !== undefined) {
        check(nullable(p[field], str));
        out[field] = p[field];
      }
    }
    if (frame.method === "item/commandExecution/requestApproval") {
      check(p.environmentId === null || str(p.environmentId));
      out.environmentId = p.environmentId;
      for (const [field, validate] of [
        ["additionalPermissions", permissions],
        [
          "networkApprovalContext",
          (v) =>
            keys(v, ["host", "protocol"]) &&
            str(v.host, 4096) &&
            ["http", "https", "socks5Tcp", "socks5Udp"].includes(v.protocol),
        ],
        [
          "proposedExecpolicyAmendment",
          (v) => array(v, (s) => str(s) && !!s) && v.length > 0,
        ],
        ["proposedNetworkPolicyAmendments", (v) => array(v, rule)],
        ["availableDecisions", (v) => array(v, decision, 32) && v.length > 0],
      ])
        if (p[field] !== undefined) {
          check(nullable(p[field], validate));
          out[field] = p[field];
        }
      // commandActions are a best-effort derived display, not permission semantics; raw stays private.
    }
  }
  check(Buffer.byteLength(JSON.stringify(out)) <= 65536);
  return { id: frame.id, method: frame.method, params: out };
}
function fileChanges(item) {
  if (!item) return null;
  check(
    item.type === "fileChange" &&
      array(
        item.changes,
        (c) =>
          keys(c, ["path", "kind", "diff"]) &&
          str(c.path) &&
          str(c.diff) &&
          ((keys(c.kind, ["type"]) &&
            ["add", "delete"].includes(c.kind.type)) ||
            (keys(c.kind, ["type", "move_path"]) &&
              c.kind.type === "update" &&
              nullable(c.kind.move_path, str))),
        32,
      ),
  );
  check(Buffer.byteLength(JSON.stringify(item.changes)) <= 65536);
  return item.changes;
}
function choices(request) {
  const p = request.params;
  if (request.method === "item/fileChange/requestApproval")
    return ["accept", "acceptForSession", "decline", "cancel"];
  if (p.availableDecisions != null) return p.availableDecisions;
  return [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
    ...(p.proposedExecpolicyAmendment
      ? [
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: p.proposedExecpolicyAmendment,
            },
          },
        ]
      : []),
    ...(p.proposedNetworkPolicyAmendments ?? []).map((r) => ({
      applyNetworkPolicyAmendment: { network_policy_amendment: r },
    })),
  ];
}
export function replyFor(request, response) {
  if (request.method !== "item/tool/requestUserInput") {
    check(
      keys(response, ["decision"]) &&
        choices(request).some((v) => isDeepStrictEqual(v, response.decision)),
    );
  } else {
    check(
      keys(response, ["answers"]) &&
        keys(
          response.answers,
          request.params.questions.map((q) => q.id),
        ) &&
        Object.keys(response.answers).length ===
          request.params.questions.length,
    );
    for (const q of request.params.questions) {
      const a = response.answers[q.id];
      check(
        keys(a, ["answers"]) &&
          array(a.answers, (s) => str(s) && !!s.trim(), 32) &&
          a.answers.length > 0 &&
          (q.isOther ||
            !q.options?.length ||
            a.answers.every((s) => q.options.some((o) => o.label === s))),
      );
    }
  }
  check(Buffer.byteLength(JSON.stringify(response)) <= 65536);
  return response;
}

export function createInteractions({ enabled, emit, respond }) {
  const pending = new Map(),
    retired = new Set(),
    received = new WeakMap();
  const key = (value) => JSON.stringify(value); // preserve string vs numeric native IDs
  const captured = (frame) => {
    received.set(frame, performance.now());
  };
  function finish(r, resolution) {
    clearTimeout(r.timer);
    pending.delete(key(r.request.id));
    retired.add(key(r.request.id));
    check(retired.size <= 256);
    emit({
      kind: "interaction_end",
      nativeRequestId: r.request.id,
      itemId: r.request.params.itemId,
      resolution,
    });
  }
  function observe(frame, active) {
    if (frame.method === "serverRequest/resolved") {
      const r = pending.get(key(frame.params?.requestId));
      if (
        r &&
        frame.id === undefined &&
        frame.params.threadId === active.context.thread.nativeThreadId
      )
        finish(r, "native_resolved");
      return true;
    }
    if (!supported(frame.method) || frame.id === undefined) return false;
    check(
      enabled &&
        !active.stopping &&
        frame.params?.threadId === active.context.thread.nativeThreadId &&
        frame.params?.turnId === active.id,
    );
    const request = projectRequest(frame, active.mode);
    const nativeItem = active.items.get(request.params.itemId);
    check(!nativeItem || !nativeItem.done);
    const changes =
      request.method === "item/fileChange/requestApproval"
        ? fileChanges(nativeItem?.native)
        : null;
    check(
      !pending.has(key(request.id)) &&
        !retired.has(key(request.id)) &&
        pending.size < 32,
    );
    const r = { request, state: "pending", timer: null };
    pending.set(key(request.id), r);
    emit({
      kind: "interaction_open",
      request,
      nativeMode: active.mode ?? "unknown",
      fileChanges: changes,
    });
    if (
      request.method === "item/tool/requestUserInput" &&
      request.params.autoResolutionMs !== null
    ) {
      const remaining =
        request.params.autoResolutionMs -
        (performance.now() - (received.get(frame) ?? performance.now()));
      r.expiresAt = performance.now() + Math.max(0, remaining);
      r.timer = setTimeout(
        () => {
          if (pending.has(key(request.id))) {
            r.state = "expired";
            emit({
              kind: "interaction_end",
              nativeRequestId: request.id,
              itemId: request.params.itemId,
              resolution: "expired",
            });
          }
        },
        Math.max(0, remaining),
      );
      r.timer.unref();
    }
    return true;
  }
  function reply(c, active) {
    check(enabled && !active.stopping);
    const r = pending.get(key(c.nativeRequestId));
    check(
      r &&
        r.request.params.itemId === c.itemId &&
        r.state === "pending" &&
        (!r.expiresAt || performance.now() < r.expiresAt),
    );
    const response = replyFor(r.request, c.response);
    r.state = "responding";
    clearTimeout(r.timer);
    respond({ id: r.request.id, result: response }); // No native ACK exists for a JSON-RPC response.
    return { nativeRequestId: r.request.id, itemId: c.itemId, sent: true };
  }
  return {
    modeChanged: (mode) => {
      if (mode !== "plan")
        for (const r of pending.values()) {
          if (
            r.request.method === "item/tool/requestUserInput" &&
            r.state === "pending"
          ) {
            clearTimeout(r.timer);
            r.state = "mode_changed";
            emit({
              kind: "interaction_end",
              nativeRequestId: r.request.id,
              itemId: r.request.params.itemId,
              resolution: "mode_changed",
            });
          }
        }
    },
    observe,
    reply,
    captured,
    terminal: () => {
      for (const r of [...pending.values()]) finish(r, "terminal");
    },
    stop: () => {
      for (const r of pending.values()) {
        clearTimeout(r.timer);
        r.state = "stopping";
        emit({
          kind: "interaction_end",
          nativeRequestId: r.request.id,
          itemId: r.request.params.itemId,
          resolution: "stop_requested",
        });
      }
    },
  };
}
