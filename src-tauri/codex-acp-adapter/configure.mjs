// Ephemeral native account operation. Never emit these snapshots as ACP events.
// No credentials, URLs, device codes or native error strings are retained in logs.
const active = (phase) =>
  ["starting", "waiting", "confirming", "canceling", "unknown"].includes(phase);
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function officialUrl(value) {
  if (typeof value !== "string" || value.length > 8192)
    throw Error("Invalid login instruction");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw Error("Invalid login instruction");
  return value;
}
function accountKind(value) {
  if (!value || typeof value.requiresOpenaiAuth !== "boolean")
    throw Error("Invalid account response");
  if (value.account === null) return "unauthenticated";
  if (value.account?.type === "apiKey") return "api_key";
  if (value.account?.type === "chatgpt") return "chatgpt";
  throw Error("Unsupported account response");
}

export function createConfigure(request) {
  let current = null,
    revision = 0;
  const retired = new Set();
  function snapshot(flow) {
    flow.exposedLoginId = flow.loginId;
    return {
      operationId: flow.operationId,
      phase: flow.phase,
      loginId: flow.loginId,
      credentialState: flow.credentialState,
      accountState: flow.accountState,
      payload: flow.phase === "waiting" ? flow.payload : null,
    };
  }
  function unknown(flow) {
    if (current !== flow) return;
    flow.phase = "unknown";
    flow.payload = null;
    flow.accountState = "unconfirmed";
    flow.credentialState = "unknown";
  }
  function completion(flow, event) {
    if (
      current !== flow ||
      !["starting", "waiting", "confirming"].includes(flow.phase)
    )
      return;
    if (!id(event.loginId)) return; // Key login has no correlatable loginId: use its RPC response.
    if (!flow.loginId) {
      if (flow.early.length >= 8) return unknown(flow);
      flow.early.push({ loginId: event.loginId, success: event.success });
      return;
    }
    if (event.loginId !== flow.loginId) return;
    if (event.success === true) {
      flow.phase = "confirming";
      flow.credentialState = "committed";
    } else if (event.success === false) flow.phase = "failed";
    else return unknown(flow);
    flow.payload = null;
  }
  async function refresh(flow) {
    if (flow.refreshing) return;
    flow.refreshing = true;
    try {
      const before = revision;
      const value = await request("account/read", { refreshToken: false });
      if (flow.phase !== "confirming") return;
      if (current !== flow || before !== revision) return unknown(flow);
      const kind = accountKind(value);
      flow.accountState = kind;
      if (
        (flow.action === "logout" && kind === "unauthenticated") ||
        (flow.action === "api_key" && kind === "api_key") ||
        (["browser", "device"].includes(flow.action) && kind === "chatgpt")
      ) {
        flow.phase = "confirmed";
        flow.credentialState =
          flow.action === "logout" ? "removed" : "committed";
      } else unknown(flow);
      flow.payload = null;
    } finally {
      flow.refreshing = false;
    }
  }
  async function cancelNative(flow) {
    if (!flow.loginId || current !== flow) return;
    const result = await request("account/login/cancel", {
      loginId: flow.loginId,
    });
    if (current !== flow) return;
    flow.payload = null;
    flow.accountState = "unconfirmed";
    if (result.status === "canceled") {
      flow.phase = "canceled";
      flow.credentialState = "unknown";
    } else unknown(flow); // notFound never proves that credentials were not committed.
  }
  async function startNative(flow, key) {
    try {
      if (flow.action === "logout") {
        await request("account/logout", {});
        if (current === flow && flow.phase !== "unknown") {
          flow.phase = "confirming";
          await refresh(flow);
        }
        return;
      }
      const params =
        flow.action === "api_key"
          ? { type: "apiKey", apiKey: key }
          : {
              type: flow.action === "browser" ? "chatgpt" : "chatgptDeviceCode",
            };
      const resultPromise = request("account/login/start", params);
      // request serializes synchronously to native stdin. Do not retain a key in the flow.
      delete params.apiKey;
      key = undefined;
      const result = await resultPromise;
      if (current !== flow) return;
      if (flow.action === "api_key") {
        if (result.type !== "apiKey") throw Error("Wrong login type");
        if (flow.phase === "unknown") return;
        flow.credentialState = "committed";
        flow.phase = "confirming";
        await refresh(flow);
        return;
      }
      const expected =
        flow.action === "browser" ? "chatgpt" : "chatgptDeviceCode";
      if (
        result.type !== expected ||
        !id(result.loginId) ||
        retired.has(result.loginId)
      )
        throw Error("Wrong login identity");
      flow.loginId = result.loginId;
      if (flow.phase === "canceling") {
        await cancelNative(flow);
        return;
      }
      if (flow.phase !== "starting") return;
      flow.payload =
        flow.action === "browser"
          ? { type: "browser", authUrl: officialUrl(result.authUrl) }
          : {
              type: "device",
              verificationUrl: officialUrl(result.verificationUrl),
              userCode: result.userCode,
            };
      if (
        flow.action === "device" &&
        (typeof result.userCode !== "string" ||
          !/^[A-Za-z0-9-]{1,128}$/.test(result.userCode))
      )
        throw Error("Invalid device instruction");
      flow.phase = "waiting";
      for (const event of flow.early) completion(flow, event);
      flow.early = [];
    } catch {
      unknown(flow);
    }
  }
  return {
    observe(frame) {
      if (!String(frame.method).startsWith("account/")) return false;
      // Unknown future account events are private too.
      if (frame.method === "account/updated") {
        revision++;
        if (current) {
          current.accountState = "unconfirmed";
        }
      }
      if (frame.method === "account/login/completed" && current)
        completion(current, frame.params ?? {});
      return true;
    },
    async command(input) {
      if (!Number.isSafeInteger(input.operationId) || input.operationId < 1)
        throw Error("Invalid Configure operation");
      if (["browser", "device", "api_key", "logout"].includes(input.action)) {
        if (
          current &&
          (active(current.phase) || input.operationId <= current.operationId)
        )
          throw Error("Configure operation is occupied or stale");
        if (
          input.action === "api_key" &&
          (typeof input.key !== "string" ||
            !input.key.length ||
            input.key.length > 65536 ||
            /[\r\n\0]/.test(input.key))
        )
          throw Error("Invalid secret reply");
        if (current?.loginId) {
          retired.add(current.loginId);
          if (retired.size > 64)
            throw Error("Connection authentication capacity exhausted");
        }
        const flow = {
          operationId: input.operationId,
          action: input.action,
          phase: "starting",
          loginId: null,
          exposedLoginId: null,
          payload: null,
          early: [],
          credentialState: "not_attempted",
          accountState: "unconfirmed",
        };
        current = flow;
        const key = input.key;
        delete input.key;
        void startNative(flow, key);
        return snapshot(flow);
      }
      const flow = current;
      if (
        !flow ||
        flow.operationId !== input.operationId ||
        input.loginId !== flow.exposedLoginId
      )
        throw Error("Stale Configure operation or login identity");
      if (input.action === "status") {
        if (flow.phase === "confirming") {
          try {
            await refresh(flow);
          } catch {
            unknown(flow);
          }
        }
        if (flow.phase === "confirmed" && flow.accountState === "unconfirmed") {
          const before = revision;
          try {
            const value = await request("account/read", {
              refreshToken: false,
            });
            if (current === flow && before === revision)
              flow.accountState = accountKind(value);
          } catch {
            flow.accountState = "unconfirmed";
          }
        }
        return snapshot(flow);
      }
      if (input.action === "cancel") {
        if (!["starting", "waiting", "confirming"].includes(flow.phase))
          throw Error("Configure operation cannot be canceled");
        flow.payload = null;
        if (["api_key", "logout"].includes(flow.action)) unknown(flow);
        else {
          flow.phase = "canceling";
          if (flow.loginId) void cancelNative(flow).catch(() => unknown(flow));
        }
        return snapshot(flow);
      }
      throw Error("Unsupported Configure action");
    },
    fail() {
      if (current) unknown(current);
    },
    pending() {
      return current && active(current.phase);
    },
  };
}
