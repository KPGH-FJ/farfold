# Same-call webpage permission: offline live WK validation

2026-10-04 07:05 UTC: 18/18 passed. Main and controlled helper exited 0, without timeout or forced termination. The view was removed; the owned socket and directory were removed. Production and harness source hashes matched before/after compilation and execution.

Receipt: [receipt-20261004T070513Z.json](receipt-20261004T070513Z.json). Full result: [sharing-20261004T070513Z.json](sharing-20261004T070513Z.json). Binary SHA-256: `28e09b32b8c9a5f39b7b0bcdef34a5e3cd1931a618696067480cfc62613eff16`. This archive stores those receipts and [build-inputs.json](build-inputs.json) at its root, with the verifier source in [harness/](harness/). The original frozen production inputs, compiler log and complete run files remain under `/Users/tw/Documents/Codex/2026-10-03/task-3/backend-share-wait-20261004/probe/final-evidence/`; that directory is not included in this archive.

## Scope

The harness directly compiles unchanged production browser_sharing, browser_workspace, transient_mcp and native BrowserWorkspace modules. It uses the typed MCP stdio launch and the same executable's real early helper. No actual Agent, model, account, production setup, user data, daily browser profile or desktop image is accessed.

Scratch Witness supplies only the network response. Within this probe process it intercepts the fixed `https://example.com/` WK request and uses Apple's public SDK-declared `loadSimulatedRequest:responseHTMLString:` to supply a constant synthetic document. There are no external resources or scripts; CSP denies network. Exactly one simulated document load occurred. This proves the real WK DOM, production command, permission and transport chain; it does not prove live website loading or actual Agent wait/cancel compatibility.

## Key assertions

1. MCP id 40 registers exact-page confirmation and stays unanswered for at least 200ms. Approval lets the original id 40 return the synthetic body of the same actual WK page. No second tool call or Agent prompt is sent.
2. Explicit stop waits for the helper's stdout barrier acknowledgement.
3. Denied id 41 ends with the same id and no body.
4. MCP cancellation for id 42 enters through independently writable stdin, ends the same id without a body, and invalidates the old approval.
5. Id 43 gets a fresh nonce and remains separate from the old request.
6. Closing removes the actual WK view. Route shutdown exits the helper normally and confirms NotFound for the exact owned socket and directory.

## Reproduce

The following records commands run in the original execution directory, not this archive. The archived harness preserves absolute source and cached-library paths; it is not a self-contained runner.

```sh
cd /Users/tw/Documents/Codex/2026-10-03/task-3/backend-share-wait-20261004/probe
sh build.sh > results/compile.log 2>&1
python3 -B run_probe.py
```

Only cached dependencies are used; nothing is installed and no .app is built. Internal timeout is 55 seconds and external timeout 65 seconds; external cleanup only targets this probe's newly created process group. Changed production inputs require recompilation. In that original execution directory, browser_sharing.rs and its child directory are read-only reference symlinks: never write through them or run recursive formatting over this harness directory.
