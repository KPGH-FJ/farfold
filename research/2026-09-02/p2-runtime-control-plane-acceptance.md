# P2 — Runtime control-plane acceptance

Date: 2026-09-02

Status: Host lifecycle and capability contract passed at source and release-build layers. This is
not formal installed-app product acceptance.

## Scope

P2 establishes one typed Host control seam around the existing Pi and OpenCode process owners. It
does not change either Runtime's Agent loop or protocol semantics, remove frontend polling, migrate
legacy JSON stores, modify profile data, replace an installed application, or promote OpenCode and
LifeModel into the formal product.

Commits:

- a3efabf — Runtime registry, pinned artifact verification, and layered capability authority;
- 905942b — Runtime supervisor, typed Adapter facade, generation, backoff, and circuit breaking.

## RuntimeRegistry

One Rust registry now owns the managed compatibility units for Pi 0.84.3 and OpenCode 1.15.13. Each
entry keeps these identities separate:

- Runtime product;
- stable installation slot;
- Runtime build including version and executable SHA-256;
- Adapter;
- default connection;
- protocol and packaged resource path.

The Pi and OpenCode fetch scripts now pin both the downloaded archive digest and the extracted
executable digest. A marker can no longer validate an arbitrary replacement executable by recording
that executable's self-derived hash. Before every managed Runtime start, the Host hashes the actual
packaged executable and runs `--version`; either mismatch blocks start.

| Runtime  | Version | Executable SHA-256                                               |
| -------- | ------- | ---------------------------------------------------------------- |
| Pi       | 0.84.3  | e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac |
| OpenCode | 1.15.13 | 1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0 |

Runtime identity constants previously duplicated across Runtime discovery, OpenCode bindings,
LifeModel source validation, and legacy preview now come from the registry. Test fixtures retain
literal values where readability is useful; they are not production authorities.

## CapabilityAuthority

The new capability snapshot keeps three layers structurally separate:

1. release certification from the preserved Pi/OpenCode installed QA evidence;
2. installation compatibility from the currently observed version and executable digest;
3. live readiness from the actual process state and current LifeModel enabled state.

Base Runtime, contribution to LifeModel, and use of LifeModel are separate fields at every layer.
For example, a running Runtime can be ready for Base and contribution while LifeModel consumption
is unavailable because LifeModel is disabled. An installation mismatch does not erase historical
release support, and release support does not claim that a stopped Runtime is ready now.

The existing descriptor shape remains available for the unchanged frontend, but its release-level
capability projection is now sourced from CapabilityAuthority instead of a second hard-coded truth.

## RuntimeSupervisor and Adapter boundary

The Tauri lifecycle commands used by the current frontend now enter RuntimeSupervisor first:

- `runtime_start`, `runtime_status`, and `runtime_stop` for Pi;
- `opencode_runtime_start`, `opencode_runtime_status`, and `opencode_runtime_stop` for OpenCode.

The typed PiAdapter and OpenCodeAdapter delegate into the existing Runtime modules. PiRuntime still
owns the Pi child, stdin, native Session behavior, generation, and event queue. OpenCodeRuntime still
owns the OpenCode Server child, authenticated loopback connection, native behavior, SSE queue, and
diagnostics. RuntimeSupervisor stores no child handle, credential, prompt, native history, or event;
therefore it cannot become a second Agent loop or process owner.

RuntimeSupervisor adds only Host coordination policy:

- one supervisor generation per installation slot;
- explicit starting, running, stopping, stopped, backoff, and circuit-open phases;
- stale completion cannot overwrite a newer stop generation;
- unexpected exits and failed transitions enter bounded exponential backoff;
- three consecutive failures open the circuit;
- an explicit typed reset is required to close an open circuit;
- snapshot output names the Runtime/build, process observation, generation, failure count, and retry
  deadline without exposing Runtime credentials or content.

Application shutdown still asks the existing Adapter-owned process states to terminate their
children. This is cleanup by the process owner, not a competing lifecycle command path.

## Immutable binding enforcement

P2 reuses the P1 transactional identity schema and immutable binding rules. The registration tests
continue to prove that an existing Farfold/native Session cannot change Runtime product,
installation, build, Adapter, connection, Project, or Working Copy and that a failed registration
rolls back the whole transaction.

No real binding was migrated in P2. The atomic legacy cutover remains P4 work.

## Verification

- `corepack pnpm format:check` — passed;
- `corepack pnpm typecheck` — passed;
- `corepack pnpm test` — 66 passed;
- `corepack pnpm build` — passed, with the existing non-blocking large-chunk warning;
- `cargo fmt --check` — passed;
- `cargo clippy --locked -- -D warnings` — passed;
- `cargo test --locked` — 73 passed, including registry, layered capability, supervisor generation,
  backoff, circuit, Runtime lifecycle, and immutable binding tests;
- `bash -n` for the Runtime fetch/wrapper scripts — passed.

A release D3 QA application was built without installation or launch:

| Field                               | Value                                                            |
| ----------------------------------- | ---------------------------------------------------------------- |
| Bundle path                         | src-tauri/target/release/bundle/macos/Farfold D3 QA.app          |
| Bundle identifier                   | ai.farfold.desktop.d3qa                                          |
| Executable SHA-256                  | cf920a1f4b6fdeb8712bc87e6c6ebaee00ca6f06018f76906d477aab3a2b9f40 |
| Packaged Pi SHA-256                 | e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac |
| Packaged OpenCode SHA-256           | 1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0 |
| `codesign --verify --deep --strict` | passed                                                           |
| Notarization                        | not attempted; no claim                                          |

The historical `/Applications/Farfold D3 QA.app` was already running during this check. The new
bundle was not installed, opened, or allowed to reuse that profile. The build evidence proves
packaging and command integration, not a new installed-app journey.

## Acceptance map

| P2 requirement                          | Evidence                                                                | Result |
| --------------------------------------- | ----------------------------------------------------------------------- | ------ |
| One approved Runtime registry           | central definitions and identity/pin consistency tests                  | Pass   |
| Stable installation/build separation    | distinct installation/build/Adapter/connection fields                   | Pass   |
| Version and digest mismatch block start | fetch-script pins plus Host pre-start verification                      | Pass   |
| Three capability layers                 | release, installation, and live structures with independent tests       | Pass   |
| Independent Base/C1/U1 truth            | separate fields; LifeModel-disabled live-readiness test                 | Pass   |
| One lifecycle coordination entry        | all frontend Pi/OpenCode start/status/stop handlers route to supervisor | Pass   |
| No duplicate process owner              | supervisor stores policy only; Adapter Runtime structs retain children  | Pass   |
| Generation and stale-result safety      | start/stop generation contract test                                     | Pass   |
| Backoff and circuit breaking            | deterministic policy tests through circuit-open and explicit reset      | Pass   |
| Immutable Session binding               | P1 transactional registration/rebinding/rollback tests still pass       | Pass   |
| No frontend behavior change             | zero frontend source change; typecheck, 66 tests, and production build  | Pass   |

## Decision and remaining truth

P2 passes its defined Host contract gate. P3 may begin.

P3 must add snapshot-plus-sequence transport, loss-aware event routing, live projection,
reconciliation, and interaction generation checks in shadow before removing either 200 ms polling
loop. The current frontend reducers, polling queues, legacy writers, and split workspaces remain in
place. No P4 binding migration or P5/P6 UI cutover is authorized by this acceptance.

The formal `/Applications/Farfold.app` remains unchanged and Pi-only. No profile data was migrated,
deleted, reset, or opened by the newly built bundle. No formal product-availability claim changes.
