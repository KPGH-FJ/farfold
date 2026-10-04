(async () => {
  if (window.__sharingProbeStarted) return;
  window.__sharingProbeStarted = true;
  const invoke = (name, args = {}) => window.__TAURI_INTERNALS__.invoke(name, args);
  const report = { workflowPass: false, steps: [], source: "production Rust modules, controlled stdio peer", networkTarget: "https://example.com/" };
  const must = (value, label) => { report.steps.push({ label, pass: !!value }); if (!value) throw new Error(label); };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const target = { agentId: "controlled", cwd: "/tmp", nativeSessionId: "controlled-session" };
  const taskKey = "controlled:/tmp:controlled-session";
  let pageArgs;
  let connected = false;
  const mcp = (id, method, params = {}) => invoke("probe_mcp", { request: { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params } });
  const call = (id) => mcp(id, "tools/call", { name: "read_page_snapshot", arguments: {} });
  try {
    report.connection = await invoke("probe_connect"); connected = true;
    must(report.connection.typedStdioServers === 1 && report.connection.routeRetained, "official typed stdio launch and route retained in memory");
    report.initialize = await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "controlled-peer", version: "0" } });
    must(report.initialize.result?.protocolVersion === "2025-06-18", "production MCP initialization on real stdout");
    await mcp(null, "notifications/initialized");
    report.tools = await mcp(2, "tools/list");
    must(report.tools.result?.tools?.length === 1 && report.tools.result.tools[0].name === "read_page_snapshot", "actual tool discovery delivers only fixed read tool");
    report.deniedBeforeAllow = await call(3);
    must(report.deniedBeforeAllow.result?.isError === true && !report.deniedBeforeAllow.result?.structuredContent, "no page observation before explicit allow");
    const opened = await invoke("browser_workspace_open", { taskKey, url: "https://example.com/", bounds: { x: 20, y: 90, width: 600, height: 280 } });
    pageArgs = { taskKey, label: opened.label, target };
    report.opened = opened;
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const events = await invoke("probe_latest");
      const event = events.filter((item) => item.label === opened.label).at(-1);
      if (event?.phase === "ready") { report.ready = event; break; }
      if (event?.phase === "blocked" || event?.phase === "error") throw new Error("public page " + event.phase);
      await sleep(50);
    }
    must(report.ready?.phase === "ready", "single actual WK reaches ready");
    report.witness = await invoke("probe_capture");
    must(Object.values(report.witness).every(Boolean), "same independent ephemeral WK sibling without user scripts");
    report.before = await invoke("browser_share_status", pageArgs);
    must(report.before.phase === "unshared", "tool connected does not mean page shared");
    report.allowed = await invoke("browser_share_allow", { ...pageArgs, expectedPageRevision: report.ready.revision });
    must(report.allowed.phase === "shared", "explicit confirmed current-page permission acknowledged");
    must(await invoke("probe_body", { version: 1 }), "first synthetic body set in captured live WK");
    report.first = await call(4);
    must(report.first.result?.isError === false && report.first.result.structuredContent?.text === "FARFOLD_PUBLIC_SHARED_BODY_ONE_20261004", "first production tool read sees actual running page");
    must(await invoke("probe_body", { version: 2 }), "same live WK body changed without reopening");
    report.second = await call(5);
    must(report.second.result?.isError === false && report.second.result.structuredContent?.text === "FARFOLD_PUBLIC_SHARED_BODY_TWO_20261004" && report.second.result.structuredContent.label === report.first.result.structuredContent.label, "second production tool read sees changed body on same page owner");
    const beforeStop = await invoke("browser_share_status", pageArgs);
    report.stopped = await invoke("browser_share_stop", { ...pageArgs, expectedRevision: beforeStop.revision });
    must(report.stopped.phase === "unshared", "stop ACK completes production output barrier");
    report.deniedAfterStop = await call(6);
    must(report.deniedAfterStop.result?.isError === true && !report.deniedAfterStop.result?.structuredContent && !JSON.stringify(report.deniedAfterStop).includes("FARFOLD_PUBLIC_SHARED_BODY"), "tool call after stop ACK returns no page body");
    await invoke("browser_workspace_close", { taskKey, label: opened.label });
    must(!(await invoke("probe_attached")), "close ACK confirms native view detached");
    report.workflowPass = true;
  } catch (error) {
    report.error = String(error);
    if (pageArgs) { try { await invoke("browser_workspace_close", { taskKey, label: pageArgs.label }); } catch (_) {} }
  }
  if (connected) {
    try {
      report.cleanup = await invoke("probe_disconnect");
      must(report.cleanup.helperExited && report.cleanup.helperExitCode === 0 && !report.cleanup.forced, "controlled helper exits normally after route shutdown");
      must(report.cleanup.socketRemoved && report.cleanup.socketDirectoryRemoved, "owned temporary socket and directory are removed");
    } catch (error) { report.workflowPass = false; report.cleanupError = String(error); }
  }
  await invoke("probe_done", { report });
})();
