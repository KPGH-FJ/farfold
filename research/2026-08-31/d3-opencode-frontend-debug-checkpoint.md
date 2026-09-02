# D3 OpenCode frontend and debug-bundle checkpoint

Date: 2026-08-31

This checkpoint proves the first Farfold-owned OpenCode product surface in source and in a freshly
built, ad-hoc-signed macOS debug bundle. It is not installed-app D3 acceptance, and OpenCode remains
`Base=unverified`, `Contributes=no`, and `Uses=no`.

## Implemented boundary

- The header Runtime chooser switches between Pi and OpenCode without embedding either Runtime's
  UI. Pi retains its existing workspace; OpenCode has a Farfold-native workspace using the official
  HTTP/SSE Server boundary.
- OpenCode Sessions are projected from the official Session and messages responses. Text,
  reasoning, tools, native busy/idle/retry/error state, and permission requests have typed Farfold
  projections. Unknown SSE envelopes remain intact at the Adapter boundary and degrade to a
  generic activity notice instead of being assigned invented semantics.
- Observed OpenCode transport coordination markers `sync` and `server.heartbeat` are treated as
  passive events. The first native user event promotes the optimistic Farfold row to the native
  message ID, so one prompt is not rendered twice.
- Permission UI preserves OpenCode's native `once`, `always`, and `reject` choices. It explicitly
  states that an Agent permission response is not a LifeModel Proposal.
- Provider, model, account, process, and Base capability remain separate. The UI reads the official
  Provider snapshot, lets the user choose one of its connected models, and continues to state that
  account readiness is unknown.

## Immutable Farfold Session binding

The host now owns an atomic `opencode-session-bindings.json` reference store. Each entry persists:

- Runtime product, installation, and Adapter identity;
- Farfold connection identity;
- canonical Project path;
- OpenCode native Session ID;
- native title and timestamps.

An existing native Session cannot be rebound to another Project, installation, or connection.
Opening a binding created by another installation fails explicitly before Farfold starts or
migrates it. The store contains references only; OpenCode continues to own native Session history.

## Debug-bundle evidence

The native UI journey below was completed on the immediately preceding debug bundle for this D3
slice. After the final async-cleanup guard was added, the current source was rebuilt again at
`src-tauri/target/debug/bundle/macos/Farfold.app`; that final bundle passed the repository checks,
signature verification, and bundled-resource hash check. The UI journey itself has not yet been
repeated against that exact final binary, so it remains debug-checkpoint rather than installed-app
acceptance.

Across that checkpoint, the bundle:

- contains the frozen OpenCode 1.15.13 executable with SHA-256
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`;
- passes `codesign --verify --deep --strict` with the local ad-hoc signature;
- visibly switched from Pi to OpenCode and showed `Base=unverified`, `Contributes=no`, and
  `Uses=no`;
- started the bundled Server, read the native `opencode/big-pickle` model, created and persisted an
  immutable Session binding, sent a real prompt, exposed Stop, and aborted the in-flight turn;
- after a separate app launch, reopened the same binding and read the same user prompt through the
  official messages API without a duplicate optimistic row.

The prompt did not complete through the Provider in this pass, so this is not knowledge-task or
coding-task acceptance.

## Exit-lifecycle defect found and fixed

The first real quit left the bundled `opencode serve` child orphaned with PPID 1. Diagnostic logs
then proved that this macOS quit path delivered Tauri's final `RunEvent::Exit` without delivering
`ExitRequested`. Cleanup had been attached only to the request event.

Farfold now stops Pi capability, Pi Runtime, and OpenCode Runtime children on the final `Exit`
event, matching Tauri's own shell-child cleanup pattern. The same direct-launch and Command-Q path
was repeated: both the Farfold process and the OpenCode child disappeared within the bounded
check, and no Runtime process remained.

## Checks

- Prettier: pass;
- TypeScript: pass;
- Vitest: 13 files, 63 tests;
- Vite production build: pass;
- Rust format: pass;
- Rust Clippy with warnings denied: pass;
- Rust tests: 40 pass;
- real bundled OpenCode lifecycle/HTTP/SSE test: pass.

## Still open before D3 acceptance

- visibly complete real knowledge and coding tasks through a usable OpenCode Provider;
- visibly exercise a real tool stream plus permission reject and allow-once;
- verify Provider failure and recovery after the latest frontend fixes;
- verify server failure/restart while the app remains open;
- repeat the complete Pi installed-app regression on the same build;
- install the exact build as a separate QA application and complete the full D3 matrix there.
