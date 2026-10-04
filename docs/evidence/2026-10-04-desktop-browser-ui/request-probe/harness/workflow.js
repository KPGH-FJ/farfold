(async () => {
  if (window.__sharingProbeStarted) return;
  window.__sharingProbeStarted = true;
  const invoke = (name, args = {}) => window.__TAURI_INTERNALS__.invoke(name, args);
  const report = { workflowPass: false, steps: [], source: "unchanged production Rust/native modules; controlled stdio peer; fixed offline WK simulated response", networkTarget: null };
  const must = (value, label) => { report.steps.push({ label, pass: !!value }); if (!value) throw new Error(label); };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const target = { agentId: "controlled", cwd: "/tmp", nativeSessionId: "controlled-session" };
  const taskKey = "controlled:/tmp:controlled-session";
  let pageArgs, connected = false;
  const mcp = (id, method, params = {}) => invoke("probe_mcp", { request: { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params } });
  const call = (id) => mcp(id, "tools/call", { name: "read_page_snapshot", arguments: {} });
  const status = () => invoke("browser_share_status", { taskKey, label: "", target });
  const waitPending = async () => {
    for (let i = 0; i < 80; i++) { const state = await status(); if (state.pendingRequest) return state; await sleep(25); }
    throw new Error("pending permission missing");
  };
  const decision = (state, allow) => invoke("browser_share_respond", { taskKey, label: state.pendingRequest.label, target, requestId: state.pendingRequest.requestId, allow });
  const noBody = (answer, id) => answer.id === id && answer.result?.isError === true && !answer.result.structuredContent && !JSON.stringify(answer).includes("FARFOLD_PUBLIC_SHARED_BODY");
  try {
    report.connection = await invoke("probe_connect"); connected = true;
    must(report.connection.typedStdioServers === 1 && report.connection.routeRetained, "official typed stdio launch retains the same route");
    const init = await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "controlled-peer", version: "0" } });
    must(init.result?.protocolVersion === "2025-06-18", "real stdio initialization");
    await mcp(null, "notifications/initialized");
    const list = await mcp(2, "tools/list");
    must(list.result?.tools?.length === 1 && list.result.tools[0].name === "read_page_snapshot", "real read-only tool discovery");
    const opened = await invoke("browser_workspace_open", { taskKey, url: "https://example.com/", bounds: { x: 20, y: 90, width: 600, height: 280 } });
    pageArgs = { taskKey, label: opened.label, target };
    for (let i = 0; i < 160; i++) {
      const events = await invoke("probe_latest"); const event = events.filter((item) => item.label === opened.label).at(-1);
      if (event?.phase === "ready") { report.ready = event; break; }
      if (event?.phase === "blocked" || event?.phase === "error") throw new Error("synthetic page " + event.phase);
      await sleep(25);
    }
    must(report.ready?.phase === "ready", "one real WK loads fixed offline response");
    report.witness = await invoke("probe_capture");
    must(Object.values(report.witness).every(Boolean), "independent ephemeral WK has no user scripts");
    // FIRST call waits and resumes. No second MCP call or prompt is sent.
    let settled = false;
    const first = call(40).then((answer) => { settled = true; return answer; });
    const pending = await waitPending();
    await sleep(200);
    must(!settled && pending.pendingRequest.label === opened.label && pending.pendingRequest.pageRevision === report.ready.revision, "id 40 remains unanswered with fixed page confirmation");
    const allowed = await decision(pending, true);
    must(allowed.phase === "shared" && !allowed.pendingRequest, "approval grants exact current page");
    report.first = await first;
    must(report.first.id === 40 && report.first.result?.isError === false && report.first.result.structuredContent?.text === "FARFOLD_PUBLIC_SHARED_BODY_ONE_20261004", "same id 40 receives real WK body after approval");
    let before = await status();
    const stopped = await invoke("browser_share_stop", { ...pageArgs, expectedRevision: before.revision });
    must(stopped.phase === "unshared", "explicit stop waits for stdout gate acknowledgement");
    // DENY ends the same outstanding call without any page content.
    const denied = call(41);
    const toDeny = await waitPending();
    await decision(toDeny, false);
    report.denied = await denied;
    must(noBody(report.denied, 41), "denied id 41 ends without body");
    // MCP cancellation is a notification through a live, independently writable stdin.
    const cancelled = call(42);
    const toCancel = await waitPending();
    await invoke("probe_cancel", { requestId: 42 });
    report.cancelled = await cancelled;
    must(noBody(report.cancelled, 42), "MCP cancellation ends same id 42 without body");
    must(!(await status()).pendingRequest, "cancelled request removes confirmation");
    let staleRejected = false;
    try { await decision(toCancel, true); } catch (_) { staleRejected = true; }
    must(staleRejected && (await status()).phase === "unshared", "late approval cannot revive cancelled id 42");
    // A new call gets a new nonce; the old id has not been retried or retargeted.
    const next = call(43);
    const nextPending = await waitPending();
    must(nextPending.pendingRequest.requestId !== toCancel.pendingRequest.requestId, "next request has a fresh confirmation identity");
    await decision(nextPending, false);
    must(noBody(await next, 43), "next denied call remains separate");
    await invoke("browser_workspace_close", { taskKey, label: opened.label });
    must(!(await invoke("probe_attached")), "native close acknowledgement removes the page");
    report.workflowPass = true;
  } catch (error) {
    report.error = String(error);
    if (pageArgs) { try { await invoke("browser_workspace_close", { taskKey, label: pageArgs.label }); } catch (_) {} }
  }
  if (connected) {
    try {
      report.cleanup = await invoke("probe_disconnect");
      must(report.cleanup.helperExited && report.cleanup.helperExitCode === 0 && !report.cleanup.forced, "controlled helper exits normally");
      must(report.cleanup.socketRemoved && report.cleanup.socketDirectoryRemoved, "owned socket and temporary directory removed");
    } catch (error) { report.workflowPass = false; report.cleanupError = String(error); }
  }
  await invoke("probe_done", { report });
})();
