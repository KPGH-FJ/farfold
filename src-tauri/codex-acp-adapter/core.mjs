import { createConfigure } from "./configure.mjs";
import { createThreads } from "./threads.mjs";
import { createPrivateEnvelopes } from "./events.mjs";
import { createTurns } from "./turns.mjs";
import { createAdmission } from "./admission.mjs";

export function serveAdapter({
  native,
  launch,
  version,
  authenticationEnabled = false,
  threadMutationEnabled = false,
  tasksEnabled = false,
  interactionsEnabled = false,
  admissionEnabled = false,
}) {
  const VERSION = version;
  const MAX = 1024 * 1024;
  const scope = launch.scope;
  const keys = Object.keys(scope);
  let initialized = false,
    busy = 0,
    failed = false,
    sequence = 0;
  const pending = new Map();
  const configure = createConfigure(request);
  const privateEnvelopes = createPrivateEnvelopes();
  const admission = createAdmission({
    request,
    launch,
    enabled: admissionEnabled,
    retain: privateEnvelopes.retain,
  });
  const threads = createThreads({
    request,
    launch,
    admission,
    mutationEnabled: threadMutationEnabled,
    retain: privateEnvelopes.retain,
    publish: (thread) =>
      write({ method: "_codex/thread/event", params: { scope, thread } }),
  });
  const turns = createTurns({
    request,
    launch,
    threads,
    admission,
    enabled: tasksEnabled,
    interactionsEnabled,
    respond: (frame) => {
      if (failed) throw Error("Native connection unavailable");
      native.stdin.write(JSON.stringify(frame) + "\n");
    },
    retain: privateEnvelopes.retain,
    publish: (turn) =>
      write({ method: "_codex/turn/event", params: { scope, turn } }),
  });
  function write(frame) {
    const bytes = JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n";
    if (Buffer.byteLength(bytes) > MAX || process.stdout.writableLength > MAX)
      return fail();
    process.stdout.write(bytes);
  }
  function fail() {
    if (failed) return;
    failed = true;
    configure.fail();
    admission.invalidate();
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(Error("Native connection lost; outcome unknown"));
    }
    pending.clear();
    native.stdin.end();
    const timer = setTimeout(() => native.kill("SIGKILL"), 2000);
    timer.unref();
    native.once("exit", () => {
      clearTimeout(timer);
      process.exit(1);
    });
    if (native.exitCode !== null || native.signalCode !== null) process.exit(1);
  }
  function frames(stream, receive) {
    let buffer = Buffer.alloc(0);
    stream.on("data", (chunk) => {
      if (failed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX) return fail();
      for (let index; (index = buffer.indexOf(10)) >= 0;) {
        const line = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        try {
          const serialized = line.toString("utf8");
          receive(JSON.parse(serialized), serialized);
        } catch {
          fail();
        }
      }
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (buffer.length) fail();
    });
  }
  function request(method, params) {
    if (failed) return Promise.reject(Error("Connection unavailable"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(fail, 10000);
      pending.set(id, { resolve, reject, timer });
      native.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  frames(native.stdout, (frame, serialized) => {
    if (frame.method) {
      admission.observe(frame);
      // Authentication envelopes are private, including unknown future auth events.
      if (configure.observe(frame)) {
        privateEnvelopes.retain(frame, serialized);
        return;
      }
      if (
        frame.id !== undefined &&
        interactionsEnabled &&
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/tool/requestUserInput",
        ].includes(frame.method)
      ) {
        turns.observe(frame, serialized);
        return;
      }
      if (frame.id !== undefined)
        native.stdin.write(
          JSON.stringify({
            id: frame.id,
            error: {
              code: -32601,
              message: "Unsupported in read-only adapter slice",
            },
          }) + "\n",
        );
      if (
        turns.observe(frame, serialized) ||
        threads.observe(frame, serialized)
      )
        return;
      privateEnvelopes.retain(frame, serialized);
    } else {
      const waiter = pending.get(frame.id);
      if (!waiter) return; // Retired native request ids never become ACP events.
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) {
        privateEnvelopes.retain(frame, serialized);
        waiter.reject(Error("Native request rejected"));
      } else if (frame.result === undefined) {
        waiter.reject(Error("Malformed native reply"));
        fail();
      } else waiter.resolve(frame.result);
    }
  });
  native.on("error", fail);
  native.on("exit", fail);
  native.stdin.on("error", fail);
  process.stdout.on("error", fail);
  frames(process.stdin, (frame) => {
    void handle(frame);
  });
  process.stdin.on("end", () => {
    failed = true;
    for (const { timer } of pending.values()) clearTimeout(timer);
    native.stdin.end();
    const timer = setTimeout(() => native.kill("SIGKILL"), 2000);
    timer.unref();
  });
  async function handle(frame) {
    if (frame.id === undefined || failed) return;
    if (
      frame.jsonrpc !== "2.0" ||
      !(typeof frame.id === "string" || Number.isSafeInteger(frame.id))
    )
      return fail();
    const error = (code, message) =>
      write({ id: frame.id, error: { code, message } });
    const control =
      frame.method === "_codex/interaction/reply" ||
      (frame.method === "_codex/turn" &&
        frame.params?.command?.action === "interrupt");
    if (busy && !control)
      return error(-32000, "Connection operation in progress");
    busy++;
    try {
      let result;
      if (frame.method === "initialize") {
        if (initialized || frame.params?.protocolVersion !== 1)
          return error(-32602, "Invalid or repeated initialize");
        const init = await request("initialize", {
          clientInfo: { name: "farfold_acp", version: VERSION },
          capabilities: { experimentalApi: true },
        });
        if (
          init.codexHome !== launch.codexHome ||
          init.platformOs !== "macos" ||
          init.platformFamily !== "unix" ||
          typeof init.userAgent !== "string"
        )
          throw Error("Native initialization identity mismatch");
        native.stdin.write(
          JSON.stringify({ method: "initialized", params: {} }) + "\n",
        );
        initialized = true;
        result = {
          protocolVersion: 1,
          agentInfo: { name: "farfold-codex-acp", version: VERSION },
          agentCapabilities: { loadSession: false },
          authMethods: [],
          _meta: {
            farfoldCodex: {
              version: 1,
              scope,
              readiness: "read_only",
              nativeVersion: "0.143.0",
              nativeLoginTypes: ["apiKey", "chatgpt", "chatgptDeviceCode"],
              loginImplemented: false,
              tasksImplemented: false,
            },
          },
        };
      } else {
        if (!initialized) return error(-32000, "Not initialized");
        const supplied = frame.params?.scope;
        if (
          !supplied ||
          Object.keys(supplied).length !== keys.length ||
          keys.some((key) => supplied[key] !== scope[key])
        )
          return error(-32602, "Stale or mismatched connection scope");
        if (frame.method === "_codex/configure") {
          if (turns.pending())
            return error(-32000, "Native Turn remains unresolved");
          if (!authenticationEnabled)
            return error(
              -32601,
              "Real authentication is disabled in this slice",
            );
          try {
            admission.invalidate();
            result = {
              scope,
              ...(await configure.command(frame.params.command ?? {})),
            };
          } catch {
            return error(-32602, "Configure operation rejected");
          }
        } else if (configure.pending()) {
          return error(-32000, "Configure operation pending");
        } else if (
          ["_codex/interaction/reply", "_codex/turn/steer"].includes(
            frame.method,
          )
        ) {
          if (!interactionsEnabled)
            return error(-32601, "Real interactions and steer are disabled");
          try {
            result = {
              scope,
              ...(frame.method === "_codex/interaction/reply"
                ? turns.reply(frame.params.command ?? {})
                : await turns.steer(frame.params.command ?? {})),
            };
          } catch {
            return error(-32001, "Interaction/control result unconfirmed");
          }
        } else if (
          frame.method === "_codex/turn" ||
          frame.method === "_codex/turn/history"
        ) {
          if (!tasksEnabled)
            return error(-32601, "Real tasks are disabled in this slice");
          try {
            result = {
              scope,
              ...(frame.method === "_codex/turn/history"
                ? { history: await turns.history(frame.params.thread) }
                : await turns.command(frame.params.command ?? {})),
            };
          } catch {
            return error(-32001, "Turn outcome unconfirmed");
          }
        } else if (turns.pending()) {
          return error(-32000, "Native Turn remains unresolved");
        } else if (frame.method === "_codex/admission") {
          if (!admissionEnabled)
            return error(-32601, "Real model admission is disabled");
          try {
            const c = frame.params.command;
            let snapshot;
            if (c?.action === "refresh") snapshot = await admission.refresh();
            else if (c?.action === "select") snapshot = admission.choose(c);
            else if (c?.action === "preflight")
              snapshot = await admission.prepare(c.thread, () =>
                threads.readBound(c.thread),
              );
            else if (c?.action === "restore") {
              await admission.refresh();
              admission.restore(c.selection);
              snapshot = admission.snapshot();
            } else throw Error("Unsupported admission operation");
            result = { scope, snapshot };
          } catch {
            admission.invalidate();
            return error(-32602, "Model admission evidence unavailable");
          }
        } else if (frame.method === "_codex/account/read") {
          const account = await request("account/read", {
            refreshToken: false,
          });
          if (account.account !== null || account.requiresOpenaiAuth !== true)
            throw Error("Only empty unauthenticated profile admitted");
          result = {
            scope,
            account: { account: null, requiresOpenaiAuth: true },
          };
        } else if (frame.method === "_codex/thread/list") {
          const list = await request("thread/list", { limit: 10 });
          if (!Array.isArray(list.data) || list.data.length || list.nextCursor)
            throw Error("Only empty profile list admitted");
          result = { scope, data: [], nextCursor: null };
        } else if (frame.method === "_codex/thread") {
          if (
            !threadMutationEnabled &&
            ["start", "resume"].includes(frame.params.command?.action)
          )
            return error(
              -32601,
              "Real thread mutation is disabled in this slice",
            );
          try {
            result = {
              scope,
              ...(await threads.command(frame.params.command ?? {})),
            };
          } catch {
            return error(
              -32001,
              "Thread operation failed; identity/outcome unconfirmed",
            );
          }
        } else return error(-32601, "Unsupported in read-only adapter slice");
      }
      write({ id: frame.id, result });
    } catch {
      error(-32000, "Native boundary failed; connection unavailable");
      fail();
    } finally {
      busy--;
    }
  }
}
