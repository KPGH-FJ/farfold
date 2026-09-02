# Farfold — Runtime-neutral Host 产品化与控制平面重构

This is the only active development plan.

Approved: 2026-09-02
Development status: explicitly authorized on 2026-09-02. P0, P1, and P2 are complete; P3 is active.
Current delivery truth: the formal installed application remains Pi-only. OpenCode and
cross-Runtime LifeModel have passed in a separately installed QA application, not in the formal
application.

## 1. Plan authority and outcome

This plan supersedes the completed R0–D4 execution sequence that previously occupied this file. The
completed evidence remains authoritative in the research reports listed below, but it is now an
input to productization rather than an authorization to continue extending the current structure.

The approved outcome is a deliberate upgrade of Farfold's Host architecture:

- keep Farfold as one native macOS desktop product with one coherent UI/UX;
- keep Pi, OpenCode, and future Agent Runtimes unmodified and semantically independent;
- rebuild Farfold's Host control plane as a typed, in-process Rust modular monolith;
- converge Pi and OpenCode onto one durable Session, Project, Working Copy, lifecycle, event,
  recovery, and capability model;
- replace the current split Runtime workspaces with one conversation-first product surface;
- retain the validated Runtime protocol and LifeModel work where it satisfies the new contracts;
- migrate incrementally through a strangler sequence, with no long-lived dual authority;
- prove the result in the exact signed formal installed application before changing product claims.

A complete rewrite of Farfold-owned Host and UI code is acceptable where that is the safest way to
remove duplicate authority. Rewriting or patching an external Runtime is not acceptable.

## 2. Current evidence and architecture diagnosis

### 2.1 Evidence that must be preserved

- plans/gate-0.md is the completed formal Pi installed-app baseline.
- research/2026-08-31-d1-runtime-ownership.md records the first Runtime ownership seam.
- research/2026-08-31/d2-pi-c1-u1-gate.md and
  research/2026-08-31/d2-minimal-lifemodel-native-acceptance.md record Pi LifeModel C1/U1 and the
  minimal governed vertical slice.
- research/2026-08-31/d3-opencode-entry-gate.md,
  research/2026-08-31/d3-opencode-base-backend-checkpoint.md,
  research/2026-08-31/d3-opencode-frontend-debug-checkpoint.md, and
  research/2026-08-31/d3-opencode-native-acceptance.md record the pinned OpenCode Adapter and QA
  installed-app evidence.
- research/2026-09-01/d4-cross-runtime-lifemodel-native-acceptance.md records Pi/OpenCode
  contribution, consumption, provenance, conflict, source withdrawal, deletion, and persistence
  evidence.

These reports prove valuable protocol behavior. They do not prove that the current architecture is
ready to become the formal daily-driver application.

### 2.2 Current source truth

The current source is a successful vertical prototype with architectural duplication:

- src/App.tsx owns the large Pi workspace and switches to a separate
  src/components/OpenCodeWorkspace.tsx tree for OpenCode.
- Pi and OpenCode each own frontend polling loops, local conversation reducers, lifecycle handling,
  and Runtime-specific command paths.
- src-tauri/src/runtime_host.rs is a stateless Pi wrapper plus descriptors; it is not yet the
  durable multi-Runtime Host authority.
- src-tauri/src/pi_runtime.rs and src-tauri/src/opencode_runtime.rs separately own process,
  generation, queue, status, and Project behavior.
- Pi Session pointers, OpenCode bindings, and LifeModel state use separate persistence mechanisms;
  OpenCode bindings and LifeModel are versioned JSON files rather than one transactional Host
  store.
- Runtime events are drained by frontend polling. There is no shared snapshot-plus-sequence
  transport, gap recovery protocol, or authoritative live projection.
- Runtime identity has begun to separate product, installation, Adapter, connection, and native
  Session, but that distinction is not yet enforced across one Host-owned schema and UI contract.
- The repository currently contains broad development changes and generated QA state. It is not a
  clean migration baseline.

The correct response is not another feature layer on top of these workspaces. The Host authority,
durable model, event transport, and product shell must be made singular before further product
expansion.

## 3. Non-negotiable boundaries

1. Farfold is independent from OpenLife. Do not copy or depend on OpenLife source, schemas, data,
   UI, or state machines.
2. Do not fork, patch, or modify Pi, OpenCode, or another Runtime.
3. Do not implement a Farfold Agent loop, canonical transcript, generic tool engine, or universal
   permission engine.
4. Do not embed or imitate a Runtime's own UI. Farfold owns its product UI and presents truthful
   Runtime-native facts.
5. A Runtime owns its Agent loop, Provider/model integration, native Session and history, tools,
   permissions, compaction, steering, abort, resume, Skills, Extensions, and Runtime-specific
   behavior.
6. A Farfold Session has an immutable Runtime installation, connection, native Session, Project,
   and Working Copy binding.
7. Base Runtime, contribution to LifeModel, and use of LifeModel remain independent capabilities.
8. Canonical LifeModel writes remain
   verified source -> atomic Proposal -> explicit user approval -> canonical LifeModel.
9. Proposal approval is never Agent tool permission.
10. Installed and signed macOS application evidence is delivery truth. Browser, fixture, CLI,
    source, and QA-bundle evidence are supporting evidence only.
11. macOS is the only platform in this plan.
12. Quitting Farfold stops Farfold-managed Runtime processes. This plan does not add a daemon,
    menu-bar worker, or background Agent.

## 4. Target Host architecture

### 4.1 Shape

The target is one Tauri application with a Rust in-process modular monolith:

```text
React product shell
  -> purpose-scoped typed Tauri commands
  -> initial Host snapshot + sequenced Tauri Channel
  -> Farfold Host control plane
       -> SQLite durable authority
       -> rebuildable live projections
       -> Runtime registry and supervisors
       -> Pi Adapter through official RPC/Extension surfaces
       -> OpenCode Adapter through official HTTP/SSE Server surfaces
  -> unmodified Runtime-native Agent loops and Sessions
```

There is one Host process and one active local profile. A second app launch activates the existing
instance rather than starting a second owner for the same profile.

### 4.2 Host modules and ownership

The implementation may refine names, but each responsibility must have exactly one owner:

- **RuntimeRegistry** — approved Runtime products, Adapter factories, installation slots, pinned
  build metadata, and release certification.
- **CapabilityAuthority** — release support, observed installation compatibility, live connection
  readiness, and Runtime-native features.
- **RuntimeSupervisor** — start, connect, stop, crash detection, generation, health, backoff, and
  circuit breaking.
- **SessionBindingIndex** — Farfold Session metadata and immutable binding to Project, Working Copy,
  Runtime installation/connection, and native Session.
- **WorkingCopyManager** — root checkout/worktree identity, occupancy, dirty-state safety, health,
  and safe removal.
- **RuntimeEventRouter** — loss-aware preservation and routing of native envelopes.
- **LiveSessionProjection** — rebuildable streaming, tool, interaction, completion, and status view.
- **SessionReconciler** — rebuilds trustworthy state from official Runtime status/history/message
  surfaces after start, reconnect, gap, overflow, or crash.
- **InteractionRegistry** — generation-scoped pending Runtime-native permission and UI interactions.
- **LifeModelGateway** — source verification, Proposal workflow, canonical store, context selection,
  injection, and manifest reconciliation.
- **UpdateRecoveryController** — migration, backup, candidate activation, rollback, recovery mode,
  diagnostics, export, restore, and reset.
- **UiTransport** — typed snapshots, monotonic sequence delivery, commands, and explicit error
  contracts.

Adapters translate between official Runtime surfaces and typed Host operations. Runtime-specific
behavior stays in the Adapter; shared UI projection does not erase unknown native envelopes.

### 4.3 Authority table

| State                                                                                                                                  | Canonical authority                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Agent loop, Provider/model, native Session/history, tools, permissions, compaction, steering, abort, resume                            | Runtime                                                                      |
| Farfold Session binding, Project/Working Copy reference, title override, pin/archive, draft, review, attention, delete/export metadata | Farfold SQLite                                                               |
| Canonical LifeModel, Proposals, source links, withdrawals, injection manifests                                                         | Farfold SQLite                                                               |
| Current stream, tool progress, pending interaction, transient health                                                                   | Rebuildable live projection                                                  |
| Diagnostics and bounded raw event ring                                                                                                 | Non-canonical bounded cache                                                  |
| Runtime credentials                                                                                                                    | Runtime-native configuration or system keychain; never Farfold logs/database |

The Host must not create a second canonical transcript. It reads native history and stores only
Farfold-owned references, user metadata, review state, and bounded evidence required by its
contracts.

## 5. Identity and durable schema

### 5.1 Identities that may never be collapsed

- runtime_product_id
- installation_id
- runtime_build_id including version and verified digest
- adapter_id
- connection_id
- Runtime supervisor generation
- project_id
- working_copy_id
- farfold_session_id
- native_session_id
- native turn/message/item/interaction identifiers where the Runtime supplies them

installation_id identifies a stable managed slot; runtime_build_id identifies the observed version
and artifact digest in that slot. Updating a managed Runtime must not silently create a new
installation identity or make an old native Session look compatible with an unverified build.

The schema must support multiple installations and connections even though the first UI exposes
only one verified managed default installation per Runtime.

### 5.2 SQLite and transaction rules

Farfold-owned durable state moves to one versioned SQLite database with foreign keys, explicit
migrations, integrity checks, and transactions. Success is returned to the UI only after the
transaction commits.

- acknowledged Farfold-owned state has RPO 0;
- migrations create a consistent backup through a safe SQLite backup mechanism;
- a migration failure never opens a silent empty database;
- corrupted or incompatible storage enters recovery mode;
- Runtime-native history remains in the Runtime and is not bulk-copied into SQLite;
- old JSON stores are read only by one bounded, idempotent migration path, then retired;
- there is no long-term dual write between legacy files and SQLite.

## 6. Runtime and capability contract

Capability truth has three layers:

1. **Release certification** — this Farfold release includes a tested Host, Adapter, schema, and
   pinned Runtime compatibility unit.
2. **Installation compatibility** — the observed executable, version, digest, protocol, and health
   match that certification.
3. **Live readiness** — connection, Provider, model, account, Project trust, and native Session are
   usable now.

Base, contributes-to-LifeModel, and uses-LifeModel are evaluated independently at each applicable
layer. A catalog entry, configured credential, or previously successful run does not prove current
readiness.

- supported and ready capabilities are enabled;
- supported but currently unavailable capabilities are disabled with a concrete reason and recovery
  action;
- unsupported actions stay out of the primary UI but remain discoverable in Runtime details;
- version or digest mismatch blocks normal managed-Runtime start;
- unknown Runtime envelopes remain inspectable and never become invented shared semantics.

Pi remains the reference Adapter and regression bar. OpenCode remains the first non-Pi Adapter.
Additional Runtimes are outside this plan until the Host contract and formal two-Runtime acceptance
pass.

## 7. Session, Project, and Working Copy model

### 7.1 Global Session model

Farfold presents one global Session list across Projects and Runtimes. A Session stores Farfold
metadata and an immutable binding:

```text
Project
  -> Working Copy (root checkout or Farfold-managed worktree)
  -> Farfold Session
  -> Runtime installation + connection + native Session
```

Selecting a different Runtime, connection, Project, or Working Copy creates or opens another
Farfold Session. It never transplants opaque Runtime state.

On launch, Farfold restores the last Project, Session, and readable native history. A Turn that was
active at shutdown/crash is marked interrupted or outcome_unknown; it is never automatically
replayed.

Session titles use a sanitized Runtime-native title or first user message, with a durable manual
override. No extra LLM call is used merely to generate a title.

### 7.2 Import and export

- Farfold automatically indexes only Sessions it created and bound.
- A user may explicitly import an exact native Session only when the Runtime provides an official
  identity/history surface and the user selects it.
- Farfold does not background-scan private Runtime stores.
- Export produces a Farfold bundle containing a manifest, index, Farfold metadata, LifeModel data,
  readable snapshots, and optional redacted diagnostics.
- Raw native Runtime data is exported only when an official surface supports it and the user
  explicitly includes it.

### 7.3 Working Copy safety

Initial concurrency is bounded to at most two active Turns across the application. Mutating
operations within one Farfold Session are serialized; safe reads may run concurrently.

- only one active Turn may mutate a given checkout/worktree;
- a second Turn targeting the same checkout waits or requires an explicitly isolated worktree;
- default worktree creation starts from the exact current HEAD/branch;
- when the root checkout is dirty, the user chooses among using HEAD only, previewing and copying
  selected local changes through an explicit supported path, or cancelling;
- Farfold never stashes, resets, discards, or silently copies user changes;
- entering another Working Copy creates another Farfold Session;
- native history is preserved across Working Copies only when an Adapter has an official,
  verified cross-cwd fork/clone operation; otherwise a new native Session is created and any
  handoff context is explicit and user-reviewed;
- archive keeps the Working Copy;
- permanent delete previews impact, blocks unsafe removal when dirty, defaults to removing the
  worktree while retaining its branch, and treats branch deletion as a separate confirmation.

Farfold owns Working Copy health, occupancy, status/diff presentation, review state, and safe
removal. It does not become a full Git delivery system and does not own commit, merge, push, or
conflict resolution.

Project relocation is explicit: preserve the stable project_id, select a replacement path, verify
identity and Working Copies, then update references transactionally.

## 8. Process lifecycle, concurrency, and commands

- Runtime startup is lazy. Browsing the Session/Project index does not start a Runtime.
- Pi uses a per-active-Session worker/controller topology unless official Pi evidence supports a
  safer shared topology without semantic regression.
- OpenCode uses one authenticated Server connection per Project/Working Copy and may host multiple
  native Sessions through its official model.
- There is no ordinary idle timeout. Resource pressure may evict only a truly idle Runtime with no
  active Turn, pending interaction, unsent accepted command, or reconciliation.
- Repeated launch/health failures trip a visible circuit breaker with a manual retry action.
- App quit attempts orderly shutdown and then confirms managed child cleanup.

During an active Turn, input uses only verified Runtime-native semantics:

- Pi may expose steer, follow-up, queue, and abort where Pi supports them.
- OpenCode exposes only its verified equivalents.
- If a Runtime cannot accept an in-flight change, Farfold saves the input as a per-Session draft;
  it does not pretend the draft was sent.

Drafts are durable per Session and are never automatically submitted after restart or reconnect.

## 9. Event transport and reconciliation

The frontend receives an initial Host snapshot followed by a monotonic, generation-scoped sequence
over Tauri Channel. Polling is removed from the product path.

The transport must distinguish:

- command accepted by the Host;
- accepted/observed by the Runtime;
- Turn started;
- streaming and tool/interaction lifecycle;
- native completion;
- failure, abort, interruption, or unknown outcome.

Text deltas may be coalesced for rendering. Lifecycle transitions, interaction requests,
completion, errors, and unknown envelopes may never be silently dropped.

A sequence gap, buffer overflow, generation change, reconnect, or contradictory lifecycle event
puts the affected Session into reconciling:

1. suspend risky writes and interaction replies;
2. query official Runtime status, native Session, history/messages, and supported change surfaces;
3. rebuild the live projection;
4. invalidate stale generation-scoped interactions;
5. resume only when the Host can state a trustworthy outcome.

Pending interactions preserve the Runtime-native payload and options. Farfold persists only
attention metadata, then re-queries the Runtime after restart/reconnect. A stale interaction can be
shown as historical but cannot be answered.

Tauri commands are purpose-scoped. The UI never receives an arbitrary raw Runtime command or
system-prompt injection escape hatch.

## 10. Product UI/UX contract

The target is a calm, professional, native-feeling macOS product with moderate density, light/dark
themes, complete keyboard navigation, a command palette, and progressive disclosure.

### 10.1 Information architecture

- **Left:** global Needs attention, searchable Project -> Session hierarchy, Recent, Pinned, and
  Archived.
- **Center:** conversation timeline, Runtime-native activity, status, and composer.
- **Right contextual area:** Session/Runtime details, Changes review, LifeModel, provenance, and
  diagnostics on demand.

The Session row shows Runtime, current status, time, and unreviewed-change/attention signals without
turning the sidebar into a dashboard.

The main work surface is conversation-first. Runtime differences appear as native capability cards
and contextual controls rather than separate products or a lowest-common-denominator UI.

### 10.2 Deliberate exclusions

The first productized UI does not embed:

- a generic terminal;
- a generic browser;
- a full code editor;
- a Runtime TUI;
- a plugin marketplace;
- an Agent graph or multi-Agent cockpit.

Per-Turn Changes appear only when Farfold can establish reliable provenance between the Turn,
Working Copy baseline, and observed diff. Otherwise the UI shows Project-level changes honestly.

## 11. LifeModel governance closure

LifeModel feature expansion is frozen until governance and recovery are complete. The initial
productized default for a new profile is disabled. It is a global user-owned profile with explicit
per-Turn selection and preview.

### 11.1 Contribution

The UI may nominate a source, but the backend must re-read the exact durable native user message
through an official Runtime surface and verify Runtime, installation, connection, native Session,
native message identifier, role, and content before creating a Source Envelope.

Only a verified Source Envelope may enter an atomic Proposal. Approval writes the canonical item in
the same durable transaction.

### 11.2 Consumption

Injection is fail-closed:

- prepare a manifest against exact canonical item versions and one target native Session;
- show the user the selected context and allow removal;
- submit through the Adapter's verified official channel;
- transition the manifest through prepared -> submission_accepted -> turn_observed, or to
  failed/abandoned;
- never record consumed without Runtime/Turn evidence;
- after crash or reconnect, reconcile without replaying the prompt.

If injection fails before submission, the prompt is not silently sent without context. The UI
offers a second explicit action to send without LifeModel.

### 11.3 Withdrawal and deletion

- audit history is distinct from the current active support set;
- a replaced or withdrawn source remains historical but no longer actively supports the canonical
  item;
- withdrawing the last active source requires an atomic preview and choice: delete the canonical
  item from future injection, or explicitly convert it to a user-authored canonical source through
  a new approval;
- canonical deletion prevents every future Runtime injection, removes active projections, and
  redacts historic manifest previews while retaining bounded audit metadata;
- conflicting values require an explicit user decision; there is no last-write-wins merge.

## 12. Data lifecycle, cleanup, and recovery

Current app-local data is development/QA data, not real user history. Its existence does not require
carrying prototype stores forever.

### 12.1 Preserve

- source code, tests, research reports, Gate 0 and D1–D4 evidence;
- pinned Runtime versions, digests, and verified distributions;
- Runtime-native credentials and global Runtime configuration;
- external Projects and their Git repositories;
- any user-selected export or backup.

### 12.2 Clean only at the authorized migration phase

- prototype Farfold Session pointers and binding indexes;
- QA-only OpenCode local Host state;
- development LifeModel values, Proposals, manifests, and generated fixtures in app-local profiles;
- obsolete legacy Host stores after migration/rollback acceptance;
- temporary QA application profiles and artifacts that are explicitly inventoried as safe to
  remove.

No cleanup occurs while writing this plan. Phase P0 must inventory exact paths, owners, value,
secrets, rollback needs, and deletion method before any removal.

The product exposes granular operations:

- archive Session;
- delete Session with preview and double confirmation;
- reset Farfold product state while preserving Runtime credentials/configuration and external
  Projects;
- a separate development reset for known QA profiles;
- export/backup before destructive migration.

If native Runtime deletion fails, Farfold keeps a visible recoverable orphan/failure record. It
never hides the mismatch.

Database corruption, incompatible migration, or failed activation enters read-only recovery mode.
Recovery mode permits diagnostics, consistent backup, export, restore, and explicit reset. It
blocks new prompts, interaction approvals, deletes, and LifeModel injection.

## 13. Managed updates and release identity

Pi and OpenCode are managed dependencies bundled with Farfold. A release is one compatibility unit:

```text
signed Farfold Host + UI
+ Adapter set
+ schema/migrations
+ pinned Runtime builds and digests
+ acceptance evidence
```

- managed Runtime self-update is disabled;
- background work may check signed stable-channel metadata only;
- download/install is explicitly initiated by the user;
- activation is blocked by an active Turn, pending interaction, migration, or other durable
  transaction;
- candidate activation performs a consistent backup, candidate migration, Runtime verification,
  and smoke tests before commit;
- any pre-commit failure rolls back Host, Runtime set, and database as one unit;
- after new user data is committed under the new schema, Farfold does not silently roll back;
  recovery is explicit;
- the formal stable application and QA application use separate bundle identifiers and data
  profiles;
- external Runtime installations are a future explicit installation type and are never silently
  mutated by Farfold.

Runtime start verifies observed version, digest where available, authenticated health, and protocol
compatibility. The current Pi path's version-only assumptions must be closed before formal
acceptance.

## 14. Security and trust

Runtime-native Project trust remains Runtime-owned. Farfold separately enforces path and Working
Copy safety for Host-owned file operations.

Required negative acceptance includes:

- arbitrary raw command/system injection across the Tauri boundary;
- path traversal, symlink escape, and Project/Working Copy identity confusion;
- loopback credential disclosure or unauthenticated OpenCode Server access;
- secrets, prompt bodies, raw native envelopes, or credentials leaking into ordinary logs;
- update metadata/artifact tampering and Runtime version/digest drift;
- a second app instance acquiring the same profile;
- malformed, duplicated, reordered, stale-generation, oversized, and unknown Runtime events;
- stale permission/interaction replies after restart or reconciliation.

Diagnostics are bounded and redacted by default. Exporting more detail is an explicit user action
with a preview.

## 15. Performance budgets

Budgets apply to the formal installed application on the supported Mac baseline:

- cold shell visible and interactive: p95 <= 2 seconds;
- persisted Project/Session sidebar usable: p95 <= 500 ms after shell readiness;
- Runtime event received by Host to UI projection: p95 <= 150 ms under normal load;
- after Runtime readiness, reconciled first trustworthy Session screen: p95 <= 2 seconds;
- large native history is paginated and must not block the composer, Stop, or interaction replies.

Performance work may coalesce text rendering and paginate native reads. It may not drop lifecycle or
governance evidence.

## 16. Ordered implementation sequence

Only one phase is active at a time. Every phase ends with evidence and a go/no-go decision. Shadow
read/projection is allowed where stated; long-lived dual write is not.

### P0 — Freeze the real baseline

Status: complete on 2026-09-02. Evidence:
research/2026-09-02/p0-baseline-ownership-and-data-map.md.

- stop feature development;
- create a clean Git checkpoint without discarding current work;
- inventory current source, stores, profiles, installed bundles, Runtime artifacts, versions,
  digests, processes, and exact formal/QA identities;
- map every Tauri command, frontend poller/reducer, durable field, and current owner;
- classify development data as preserve, migrate, export, or delete, with exact paths and rollback;
- rerun the repository checks and preserve the last Pi/OpenCode/LifeModel installed evidence.

Exit: one reviewed ownership map, data cleanup map, artifact manifest, and recoverable clean
baseline. No data is deleted merely to pass P0.

### P1 — Establish durable Host foundations

Status: complete on 2026-09-02. Evidence:
research/2026-09-02/p1-host-foundation-acceptance.md.

- introduce typed IDs and the SQLite schema;
- implement migration, backup, integrity, transaction, single-instance, and recovery-mode
  foundations;
- implement a bounded legacy preview/ledger without copying native Runtime transcripts;
- prove idempotent schema migration and rollback before later binding cutover;
- defer actual legacy Session binding activation to P4, where the SessionBindingIndex and official
  Runtime validation surfaces exist.

Exit: SQLite is the sole authority for new Host foundation state. No legacy state is dual-written;
legacy product writers remain unchanged until the atomic P4 cutover.

### P2 — Build registry, capability authority, supervisors, and Adapter facade

Status: complete on 2026-09-02. Evidence:
research/2026-09-02/p2-runtime-control-plane-acceptance.md.

- implement RuntimeRegistry, CapabilityAuthority, RuntimeSupervisor, and the typed Adapter boundary;
- wrap Pi and OpenCode protocol modules without changing Runtime semantics;
- separate release certification, installation compatibility, and live readiness;
- enforce all identity and immutable binding rules.

Exit: Pi and OpenCode lifecycle/capability contract tests pass with no frontend behavior change and
no duplicate process owner.

### P3 — Introduce snapshot, Channel, sequence, and reconciliation

Status: active.

Implementation checkpoint on 2026-09-03: RuntimeEventRouter, the race-safe initial snapshot,
Channel delivery, monotonic sequence/gap evidence, LiveSessionProjection, SessionReconciler, and
InteractionRegistry now run in shadow. Pi reconciliation waits for generation-scoped correlated
`get_state`/`get_messages` responses and rejects torn snapshots; OpenCode reconciliation uses its
official Session list/message HTTP surfaces. Runtime-native dialogs and permissions are registered
by generation and native Session, with stale and duplicate replies rejected. Existing frontend
polling and reducers remain the comparison baseline.

Frontend shadow checkpoint on 2026-09-03: the existing application now starts a typed Host Channel
consumer alongside polling. It hydrates from the race-safe cursor, paginates bounded catch-up,
deduplicates delivery, exposes content-free projection/interaction state to QA, and marks stream
replacement or explicit/implicit sequence gaps for reconciliation. The Channel event carries the
corresponding backend projection and pending-interaction snapshot; it still does not drive visible
product state.

Transport parity checkpoint on 2026-09-03 (`f08567d`): both unchanged polling consumers now feed a
content-free parity ledger alongside the typed Channel. Exact Runtime identity, generation, kind,
payload fingerprint, and multiplicity must match; the ledger retains only bounded fingerprints and
counts, marks capacity eviction as reconciliation-required evidence, and removes its legacy
observer on subscribe, hydrate, and explicit-stop failures. Deterministic tests cover exact matches,
duplicates, generation mismatch, bounded overflow, failed subscription cleanup, normal stop,
paginated catch-up before concurrently buffered live events, and hydration-failure unsubscribe.
This is instrumentation and deterministic recovery evidence only; installed Pi/OpenCode journey
parity remains open.

Installed entry checkpoint on 2026-09-03:
`research/2026-09-03/p3-installed-shadow-checkpoint.md`. The isolated P3 QA bundle passed signing,
identity, Runtime-pin, launch, and initial-surface checks. Project/Session parity and injected
recovery journeys remain open, so this evidence does not satisfy the P3 exit.

- build RuntimeEventRouter, LiveSessionProjection, SessionReconciler, InteractionRegistry, and
  UiTransport;
- run the new projection in shadow against current installed journeys;
- inject gaps, overflow, restart, malformed events, and stale interactions;
- remove polling only after parity and recovery evidence pass.

Exit: the new Host can reconstruct trustworthy Pi and OpenCode Session state and the UI no longer
depends on Runtime event polling.

### P4 — Unify Session, Project, Working Copy, draft, archive, and delete

- implement the global SessionBindingIndex and WorkingCopyManager;
- add durable drafts, attention/review metadata, import/export, archive/delete, and relocation;
- implement truthful Runtime capability presentation;
- migrate old Farfold bindings into the unified model.

Exit: both Runtimes coexist in one durable global index with immutable bindings and recoverable
delete/import/export behavior.

### P5 — Move the existing UI entirely onto the new Host

- keep the current visual surface while replacing its data and command sources;
- eliminate direct Runtime-specific lifecycle ownership from React;
- rerun the complete Pi formal baseline and OpenCode QA baseline.

Exit: the old UI is fully served by the new Host, with zero old durable writers and zero frontend
Runtime pollers. This is the rollback boundary before the visual rewrite.

### P6 — Deliver the conversation-first UI rewrite

- implement the approved left/center/right information architecture;
- unify Pi/OpenCode Sessions while keeping Runtime-specific capability cards;
- complete keyboard, focus, light/dark, command palette, accessibility, narrow-window, and long-data
  behavior;
- keep terminal/browser/editor/Runtime TUI outside the product.

Exit: the UI passes real-state visual and accessibility acceptance without invented Runtime facts.

### P7 — Add bounded concurrency, Working Copy isolation, and Changes review

- enforce the two-active-Turn application limit and per-Session mutation serialization;
- implement checkout occupancy and explicit worktree creation/removal;
- add per-Turn Changes only where provenance is reliable;
- test dirty checkout, simultaneous Sessions, crash, abort, and deletion safety.

Exit: parallel work cannot silently share or destroy a Working Copy, and every displayed per-Turn
change has defensible provenance.

### P8 — Close LifeModel governance, update, recovery, and security

- migrate LifeModel into the transactional Host store;
- implement backend source re-read, fail-closed injection, manifest states, last-source policy, and
  deletion redaction;
- implement managed update candidate activation and explicit recovery;
- complete the negative security matrix.

Exit: no governance state is inferred from UI intent, no failed injection silently changes the
prompt contract, and update/recovery cannot split Host/Runtime/schema truth.

### P9 — Formal installed-app product acceptance

- build one stable candidate with exact Runtime artifacts and schema;
- verify signing, bundle ID, data profile, executable and Runtime hashes;
- run the complete acceptance matrix below with real Providers in the same installed candidate;
- repeat Pi regression and confirm no QA profile or fixture contributed product state.

Exit: every required journey maps to exact same-build evidence. Only then may formal product claims
change from Pi-only.

### P10 — Retire prototype paths and clean authorized development data

- remove obsolete workspaces, pollers, JSON stores, duplicate reducers/owners, and migration-only
  code after rollback criteria expire;
- execute only the reviewed P0 cleanup map;
- preserve credentials, Runtime global configuration, external Projects, research, tests, and
  required evidence;
- verify reset/export/recovery one final time.

Exit: one Host authority, one product shell, one active data schema, no hidden orphaned QA state,
and a clean repository checkpoint.

## 17. Exact formal acceptance matrix

All applicable scenarios must pass in the same signed formal installed application and executable
hash:

1. Pi and OpenCode discovery, pinned artifact verification, Provider/model readiness, and truthful
   unavailable states.
2. New Session, send, stream, tools, completion, restart, native history resume, title override,
   archive, delete, import, and export for both Runtimes where officially supported.
3. Pi steering, follow-up, queue/abort, Extensions, Skills, compaction, and Project trust without
   semantic regression.
4. OpenCode permission, abort, Server restart, connection failure, and native Session resume.
5. Global Project/Session navigation, last-state restore, per-Session drafts, Needs attention, and
   no automatic replay of interrupted Turns.
6. Two concurrent Turns within the bound, same-checkout exclusion, explicit worktree isolation,
   dirty checkout refusal/choice, crash recovery, and safe worktree removal.
7. Snapshot/sequence delivery, event gap, overflow, generation change, malformed event, reconnect,
   reconciliation, stale interaction invalidation, and outcome-unknown handling.
8. LifeModel disabled/empty operation; verified Pi and OpenCode contribution; Proposal
   edit/approve/reject; cross-Runtime use; explicit remove-before-send; injection failure;
   conflict; source withdrawal; last-source choice; canonical deletion; redaction; restart.
9. Database migration, transaction failure, corruption, read-only recovery, backup, export, restore,
   granular reset, and failed native deletion.
10. Signed update metadata, tampered artifact rejection, active-Turn update block, candidate
    migration, smoke failure rollback, successful activation, and explicit post-commit recovery.
11. All security negative cases in section 14.
12. All performance budgets in section 15 with large Session history.
13. Quit stops every Farfold-managed Runtime process; second launch activates the existing profile.
14. The installed executable, bundled Runtime builds, database schema, and evidence manifest all
    belong to the same candidate.

Browser demos, fixtures, source tests, standalone Runtime harnesses, and separately installed QA
applications may diagnose failures. They cannot satisfy this matrix.

## 18. Stop conditions

Stop the current phase and return to design when:

- a change requires Runtime source modification or undocumented private-store parsing;
- shared projection would discard a Runtime-native fact required for correct user action;
- two components can both claim canonical ownership of lifecycle, binding, durable state, or
  governance;
- a migration cannot demonstrate backup, idempotence, and recovery;
- a worktree operation could discard or silently relocate user changes;
- an injection could send a prompt with a different context contract than the user approved;
- the exact installed candidate cannot be identified and reproduced;
- formal Pi regression fails.

## 19. Explicit non-goals

- Windows, Linux, cloud hosting, remote Host, collaboration, billing, or public distribution;
- daemon/background Agents or work continuing after Farfold quits;
- more Runtimes before Pi/OpenCode formal acceptance;
- arbitrary external Runtime versions in the managed path;
- Runtime patching, Runtime UI embedding, or private-store scraping;
- a Farfold Agent loop, permission engine, canonical transcript, or universal event ontology;
- a generic terminal, browser, editor, Runtime TUI, Agent graph, or plugin marketplace;
- a full Git commit/merge/push/conflict-resolution platform;
- LifeModel feature expansion beyond governance closure;
- automatic native Session scanning, automatic interrupted-Turn replay, or silent prompt fallback;
- OpenLife migration or compatibility.

## 20. Current implementation action

P0 through P2 passed without deleting or migrating profile data. P3 is the only active
implementation phase. Next, compare the typed shadow consumer's Pi/OpenCode Session projection
against the unchanged polling reducers. Content-free fingerprint/multiplicity accounting is now in
place, and deterministic catch-up/live-buffer plus hydration-failure injection passes. Next, run
real installed Pi/OpenCode journeys and inject stream gaps, overflow, restart, malformed events,
torn reconciliation, and stale Runtime-native interactions in installed QA. Only after parity and
recovery evidence pass may polling be removed and P3 accepted. Do not retire a legacy writer,
replace an installed app, or start P4 before that gate.
