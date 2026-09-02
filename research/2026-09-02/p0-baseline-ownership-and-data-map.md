# P0 — Baseline, ownership, artifact, and data map

Captured: 2026-09-02 21:04 CST

Status: complete for the non-destructive P0 gate.

This report freezes the source/runtime truth that must precede the Host control-plane rebuild. It
does not delete data, replace an installed application, mutate a Runtime, or claim that the formal
application supports OpenCode or LifeModel.

## 1. Git baseline

| Item                  | Captured value                                                 |
| --------------------- | -------------------------------------------------------------- |
| Branch                | main                                                           |
| Baseline commit       | 7ea700f480e1dc60f1f7bf61fd0a34177830434f                       |
| Commit title          | feat: complete multi-runtime QA baseline                       |
| Remote relationship   | main is two local commits ahead of origin/main                 |
| Worktree after commit | clean, excluding intentionally ignored build/runtime artifacts |

The baseline commit contains the completed Pi/OpenCode/LifeModel prototype, research and installed
QA evidence, and the approved successor plan. No Provider credential, ignored Runtime executable,
capability-bridge dependency tree, or local app data was committed.

Repository checks at this baseline:

- corepack pnpm format:check — passed;
- corepack pnpm typecheck — passed;
- corepack pnpm test — 66 passed;
- corepack pnpm build — passed, with a non-blocking large-chunk warning;
- cargo fmt --check — passed;
- cargo clippy --locked -- -D warnings — passed;
- cargo test --locked — 49 passed.

## 2. Installed application manifest

All three installed bundles passed codesign --verify --deep --strict. These are distinct delivery
truths:

| Application                     | Bundle identifier       | Executable SHA-256                                               | Product claim                     |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------- | --------------------------------- |
| /Applications/Farfold.app       | ai.farfold.desktop      | cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23 | Formal Pi-only Gate 0 application |
| /Applications/Farfold D2 QA.app | ai.farfold.desktop.d2qa | bffacc3e59a42e37fcf0f9505cf2d194852b95fc6a53e54244e0da52a0691a1f | Historical Pi LifeModel QA        |
| /Applications/Farfold D3 QA.app | ai.farfold.desktop.d3qa | 3cb42db260b0f4ee77e5c027e16d4bc6490ac3de67a044bb3d8179283550f2d4 | OpenCode and cross-Runtime QA     |

The formal executable hash still matches plans/gate-0.md. The two QA hashes may support diagnosis
and regression; they do not promote features into the formal application.

At capture time, Farfold D3 QA was running as PID 15023 with its Pi capability bridge child PID 15027. No Pi Agent or OpenCode Server child was observed by executable name. This process snapshot
is diagnostic and may become stale; migration/update work must acquire its own live quiescence
check.

## 3. Runtime artifact manifest

| Artifact                                      | Version            | Local SHA-256                                                    | Packaging state                         |
| --------------------------------------------- | ------------------ | ---------------------------------------------------------------- | --------------------------------------- |
| src-tauri/resources/pi-runtime/pi             | 0.84.3             | e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac | Ignored, rebuildable pinned Runtime     |
| src-tauri/resources/opencode-runtime/opencode | 1.15.13            | 1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0 | Ignored, rebuildable pinned Runtime     |
| src-tauri/capability-bridge/runtime/node      | local bundled Node | 5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c | Ignored, rebuildable capability runtime |

Pi's marker records version 0.84.3 and source archive digest
0120c9f99ea05fe801e6e7c2c9d91dd65636563ca0803711b37b9f32920d4b63. OpenCode's marker records
version 1.15.13, archive digest
be369a38d15a22e83fad34874d1bc7ddead8084e07df292b28d079287d54ab0c, and binary digest
1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0.

The Pi binary digest is identical in all three installed applications. The OpenCode binary exists
only in the D3 QA application and matches the local pinned artifact. The capability Node digest is
identical in all three installed applications.

Current gap: OpenCode verifies executable version and authenticated Server health at start; Pi's
Host descriptor asserts the pinned version but does not independently verify the observed packaged
binary digest at each start. P1/P2 must represent build identity explicitly, and formal acceptance
must close the Pi observed-artifact verification path.

## 4. Local profile inventory

No contents of credential/configuration files were read.

| Profile path                                                  | Files | Native Pi Session files | Approximate size | Classification                                                                                                                 |
| ------------------------------------------------------------- | ----: | ----------------------: | ---------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| /Users/tw/Library/Application Support/ai.farfold.desktop      | 3,467 |                      18 |           65 MiB | Preserve Gate 0 Sessions until migration/export; migrate Farfold pointer metadata; OpenCode state is development contamination |
| /Users/tw/Library/Application Support/ai.farfold.desktop.d2qa |     9 |                       7 |           40 KiB | Preserve until P8 regression; delete as a whole only in authorized P10 cleanup                                                 |
| /Users/tw/Library/Application Support/ai.farfold.desktop.d3qa | 3,484 |                       1 |           63 MiB | Preserve until P9 formal replacement evidence; delete as a whole only in authorized P10 cleanup                                |

The formal profile contains last-pi-session.json, sessions/, workspace/,
opencode-session-bindings.json, and opencode/. Because the installed formal application is
Pi-only, the OpenCode files in that profile prove that development runs reused the formal bundle
identity. This is not valid formal product data and must not be silently inherited.

The D2 profile contains Pi Sessions, a Pi pointer, and lifemodel.json. The D3 profile contains Pi
Sessions, a Pi pointer, lifemodel.json, OpenCode bindings, and an isolated OpenCode XDG-style
directory. These are development/QA records, not real user history.

## 5. Current durable authorities

| Durable state                                   | Current location                              | Current writer/authority                   | Target disposition                                                                    |
| ----------------------------------------------- | --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Pi native history                               | profile sessions/*.jsonl                      | Pi Runtime                                 | Remains Runtime-native; never copied into the Host database                           |
| Last Pi Project/Session pointer                 | profile last-pi-session.json                  | PiRuntime                                  | Idempotently migrate into SessionBindingIndex, then retire                            |
| OpenCode native history/config/cache            | profile opencode/                             | OpenCode Runtime                           | Remains Runtime-native; cache is rebuildable; configuration/credentials are protected |
| OpenCode Farfold bindings                       | profile opencode-session-bindings.json        | OpenCodeBindingRepository                  | Idempotently migrate into SessionBindingIndex, then retire                            |
| LifeModel Proposals/items/withdrawals/manifests | profile lifemodel.json                        | LifeModelRepository                        | Migrate only QA fixtures needed for regression; new canonical writes move to SQLite   |
| Pi Provider/model auth and global settings      | Pi-native configuration via capability bridge | Pi                                         | Preserve; never migrate into Farfold SQLite                                           |
| OpenCode Provider/model auth/config             | Runtime-native configuration                  | OpenCode                                   | Preserve until exact ownership is verified; never log or copy secrets                 |
| UI transient conversation/progress              | React component state                         | App.tsx or OpenCodeWorkspace.tsx           | Replace with rebuildable LiveSessionProjection                                        |
| Raw runtime queues/log rings                    | Rust in-memory VecDeque                       | PiRuntime, PiCapabilities, OpenCodeRuntime | Keep bounded and non-canonical behind RuntimeEventRouter                              |

Current JSON writes are individually atomic, but they cannot transactionally bind a Farfold
Session, Project, Runtime identity, draft/review state, LifeModel action, and migration state. This
is the concrete reason P1 introduces one Farfold-owned SQLite authority.

## 6. Current process and lifecycle owners

| Area                                      | Current owner                          | Current limitation                                   | Target owner                                          |
| ----------------------------------------- | -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| Pi process/session/generation/event queue | PiRuntime                              | Pi-specific global state and polling queue           | Pi Adapter plus RuntimeSupervisor                     |
| Pi capability bridge                      | PiCapabilities                         | Separate process and polling queue                   | Pi Adapter plus CapabilityAuthority/RuntimeSupervisor |
| OpenCode Server/generation/SSE queue/logs | OpenCodeRuntime                        | Project-specific state outside shared Host lifecycle | OpenCode Adapter plus RuntimeSupervisor               |
| Pi request correlation                    | Frontend adapter plus Pi RPC responses | Split acceptance/lifecycle knowledge                 | Adapter operation contract plus projection            |
| OpenCode protocol calls                   | opencode_protocol                      | Commands bypass a shared Session command authority   | OpenCode Adapter behind purpose-scoped Host commands  |
| App-exit child cleanup                    | lib.rs                                 | Final exit only; no shared quiescence/update gate    | RuntimeSupervisor                                     |

The Runtime retains Agent-loop semantics. Moving lifecycle ownership into RuntimeSupervisor means
coordinating and observing Runtime processes; it does not mean reimplementing their loops.

## 7. Tauri command ownership map

There are 38 registered commands.

### Pi capability bridge — 3

- pi_capabilities_start
- pi_capabilities_send
- pi_capabilities_poll

Current owner: PiCapabilities. Target: Pi Adapter, CapabilityAuthority, RuntimeSupervisor, and
UiTransport. The generic raw-send/poll shape must not survive as a public UI escape hatch.

### LifeModel — 10

- lifemodel_snapshot
- lifemodel_create_proposal
- lifemodel_update_proposal
- lifemodel_approve_proposal
- lifemodel_reject_proposal
- lifemodel_delete_item
- lifemodel_withdraw_source
- lifemodel_set_enabled
- lifemodel_prepare_injection
- lifemodel_finish_injection

Current owner: LifeModelRepository over lifemodel.json. Target: LifeModelGateway over SQLite with
backend source re-read and reconciled manifest transitions.

### Shared/Pi Runtime Host facade — 10

- runtime_discover
- opencode_runtime_discover
- runtime_start
- runtime_send
- runtime_stop
- runtime_status
- runtime_list_sessions
- runtime_project_readiness
- runtime_remember_session
- runtime_poll_events

Current owner: runtime_host descriptors plus direct delegation to PiRuntime, with separate OpenCode
discovery. Target: RuntimeRegistry, CapabilityAuthority, RuntimeSupervisor, SessionBindingIndex,
RuntimeEventRouter, and purpose-scoped UiTransport. runtime_send and runtime_poll_events must be
replaced rather than generalized.

### OpenCode lifecycle/diagnostics — 6

- opencode_runtime_start
- opencode_runtime_status
- opencode_runtime_readiness
- opencode_runtime_stop
- opencode_runtime_poll_events
- opencode_runtime_diagnostics

Current owner: OpenCodeRuntime. Target: OpenCode Adapter plus RuntimeSupervisor/EventRouter.

### OpenCode native protocol — 7

- opencode_provider_snapshot
- opencode_session_create
- opencode_session_list
- opencode_session_messages
- opencode_prompt_async
- opencode_session_abort
- opencode_permission_respond

Current owner: opencode_protocol against the authenticated Server. Target: OpenCode Adapter behind
Session-bound, purpose-scoped Host operations. The official HTTP/SSE semantics remain unchanged.

### OpenCode binding store — 2

- opencode_binding_list
- opencode_binding_remember

Current owner: OpenCodeBindingRepository over opencode-session-bindings.json. Target:
SessionBindingIndex over SQLite. Native Session binding remains immutable.

## 8. Frontend authority map

| Surface                    | Current implementation               | Finding                                                                                                                                           |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi product workspace       | src/App.tsx                          | Large component owns Pi lifecycle, Provider state, Session list, conversation projection, LifeModel integration, and 200 ms Pi/capability polling |
| OpenCode product workspace | src/components/OpenCodeWorkspace.tsx | Separate product tree owns OpenCode lifecycle, bindings, history, permission, LifeModel, 200 ms event polling, and independent status polling     |
| Pi projection              | src/runtime/conversation.ts          | hydrateTimeline and reducePiEvent                                                                                                                 |
| OpenCode projection        | src/runtime/opencode-conversation.ts | hydrateOpenCodeTimeline and reduceOpenCodeEvent                                                                                                   |
| Runtime contract           | src/runtime/adapter.ts               | Useful typed vocabulary, but its Pi-shaped method set and pollEvents operation are not the final Host contract                                    |
| Runtime selection          | src/components/RuntimeChooser.tsx    | Switches entire workspaces rather than selecting/opening an immutable bound Farfold Session                                                       |

The two workspaces are the largest duplicate authority. P3 moves lifecycle/event truth into the
Host, P5 places the existing UI on that Host, and only P6 rewrites the visual product surface.

## 9. Data preserve/migrate/export/delete map

### Preserve

- Git baseline 7ea700f and all research/Gate 0/QA evidence committed with it;
- external Project directories and Git repositories;
- Runtime-native credentials and global configuration;
- pinned Runtime source/archive/binary digests and third-party license;
- formal Pi native Sessions until a user-readable export and pointer migration are verified;
- D2/D3 QA profiles until their regression value is replaced by P8/P9 evidence.

### Migrate

- valid last-pi-session.json Project/native Session reference into the unified Farfold Session
  binding;
- valid opencode-session-bindings.json entries into immutable SessionBindingIndex records;
- only the LifeModel fixtures explicitly needed to prove migration and governance compatibility;
- manual Farfold title metadata where it can be distinguished from Runtime-native title.

Migration is copy-verify-activate, never destructive move. The legacy file remains intact until the
new database passes idempotence, integrity, and rollback tests.

### Export before deletion

- a redacted manifest and readable summary of each QA profile;
- exact installed bundle/runtime hashes and acceptance report references;
- any Pi/OpenCode native Session selected for future regression;
- LifeModel canonical/proposal/manifest fixtures selected for P8 migration tests.

### Delete later, not in P0

- OpenCode Host state that contaminated the formal ai.farfold.desktop profile;
- obsolete Pi pointer and OpenCode binding JSON after successful migration and rollback-window
  expiry;
- D2 and D3 QA application bundles and profiles after same-build formal P9 acceptance;
- rebuildable caches, generated QA-only fixtures, and temporary Runtime files named by the P10
  cleanup manifest;
- obsolete frontend pollers, duplicate workspaces/reducers, and migration-only code after P5/P10
  gates.

### Never delete as part of Farfold cleanup

- external Projects, repositories, branches, worktrees, or uncommitted user changes;
- Runtime-native credentials/global settings without a separate explicit user request;
- research, licenses, Git history, or exact evidence required to explain a released build.

## 10. Cleanup safety and rollback

Before any later cleanup:

1. require no active Turn, interaction, reconciliation, migration, or update;
2. identify bundle/profile by exact bundle identifier and canonical path;
3. create a consistent backup/export and verify it can be read;
4. copy legacy state into the candidate SQLite database;
5. validate record counts, immutable identities, referential integrity, and Runtime-native
   resolvability;
6. activate the new database without deleting the legacy source;
7. pass restart, recovery, and rollback tests;
8. retain legacy files through the declared rollback window;
9. show the exact deletion preview and require the plan's explicit destructive-action gate;
10. delete only named paths, then verify credentials, Runtime configuration, and external Projects
    remain untouched.

## 11. P0 gate decision

| Exit requirement           | Evidence                                                                           | Result |
| -------------------------- | ---------------------------------------------------------------------------------- | ------ |
| Recoverable clean baseline | Commit 7ea700f; clean worktree; complete checks                                    | Pass   |
| Ownership map              | Sections 5–8 map durable, process, command, and UI owners                          | Pass   |
| Artifact manifest          | Sections 2–3 record bundle IDs, versions, hashes, signatures, and process snapshot | Pass   |
| Data cleanup map           | Sections 4 and 9–10 classify exact profiles and rollback order                     | Pass   |
| No destructive cleanup     | No profile, Runtime, Project, app, or credential was changed                       | Pass   |

Go decision: P1 may begin with non-destructive typed identity and SQLite foundations. No migration
activation, legacy-store retirement, app replacement, or data deletion is authorized merely by
this P0 completion.
