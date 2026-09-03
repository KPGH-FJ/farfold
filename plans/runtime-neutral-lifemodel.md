# Farfold — Runtime-neutral Host 产品化与控制平面重构

This is the only active development plan.

Approved: 2026-09-02
Development status: explicitly authorized on 2026-09-02. P0 through P3 are complete; P4 is active.
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

Status: complete on 2026-09-03. Installed evidence:
`research/2026-09-03/p3-installed-shadow-checkpoint.md`.

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
corresponding backend projection and pending-interaction snapshot. This was the pre-cutover shadow
state; the later cutover checkpoint below supersedes its visible-state limitation.

Transport parity checkpoint on 2026-09-03 (`f08567d`): both unchanged polling consumers now feed a
content-free parity ledger alongside the typed Channel. Exact Runtime identity, generation, kind,
payload fingerprint, and multiplicity must match; the ledger retains only bounded fingerprints and
counts, marks capacity eviction as reconciliation-required evidence, and removes its legacy
observer on subscribe, hydrate, and explicit-stop failures. Deterministic tests cover exact matches,
duplicates, generation mismatch, bounded overflow, failed subscription cleanup, normal stop,
paginated catch-up before concurrently buffered live events, and hydration-failure unsubscribe.
This is instrumentation and deterministic recovery evidence only; installed Pi/OpenCode journey
parity was still open at that checkpoint.

Visible-state cutover checkpoint on 2026-09-03 (`37cf98a`): Pi and OpenCode now receive Runtime
events from the validated Host Channel native envelope. Formal builds no longer call either Runtime
event poller; the old pollers remain enabled only in the isolated P3 QA build as comparison probes
and no longer feed the visible reducers. Host delivery validates native preservation, Runtime
generation, and event kind before forwarding, deduplicates by stream/sequence, and records malformed
or oversized envelopes as reconciliation reasons. Production-mode tests prove Channel delivery
without starting a parity ledger, while QA-mode tests retain bounded equality and failure injection.

Installed entry checkpoint on 2026-09-03:
`research/2026-09-03/p3-installed-shadow-checkpoint.md`. The isolated P3 QA bundle passed signing,
identity, Runtime-pin, launch, and initial-surface checks. The later `f2ab4a1` release candidate also
passed content-free Channel/polling parity for installed Pi bootstrap, Pi stop/restart, OpenCode
start, exact native Session reopen, and cross-Runtime switching: its release run ended at `23 / 23`
with zero unmatched events, gaps, or reconciliation reasons, while a preceding debug diagnostic run
reached `49 / 49`. No Provider task was sent. A real Turn, Runtime-native interaction journey, and
installed injected-gap recovery remained open.

The later `37cf98a` release candidate repeated the installed journey after Channel became the
visible-state source: Pi reached ready at `20 / 20`, switching away from Pi reached `21 / 21`, and
reopening exact OpenCode native Session `ses_f9c6fefa9ffeARsf3raAANPTXq` reached `24 / 24`, with zero
unmatched events, gaps, or reconciliation reasons. Its installed main executable SHA-256 is
`1d0887b74f3b684b5cd6fe1526ac703623eb5cc5e0be0d26ad8737766f61b4bd`; bundled Pi and OpenCode
artifacts retain their pinned SHA-256 values. No prompt or Provider request was sent. A real Turn,
Runtime-native interaction journey, and installed injected-gap recovery remain open, so P3 remains
active and QA-only comparison polling remains available.

Automatic reconciliation checkpoint on 2026-09-03 (`df5ff4b`): subscription Ready now includes
the LiveSessionProjection and pending-interaction snapshot captured under the same Runtime event
router lock as its sequence cursor. The Tauri boundary explicitly serializes those fields as
camelCase; this also repairs the pre-existing pending-interaction delivery mismatch. Transport and
projection uncertainty create monotonic, installation-scoped recovery revisions. Pi and OpenCode
suspend sends, mutable selection, and interaction replies; invoke only their purpose-scoped official
reconcilers; rebuild visible native state; and acknowledge the exact revision only after successful
hydration. The signed installed release candidate (main SHA-256
`a59856d10d026f987bc4b6093487eccd85f9200f2b5b0b49273dca35adc022f2`) exercised Pi generation
restart and exact OpenCode Session restart/reopen, ending at `3` acknowledged recoveries and
`53 / 53` transport parity with no Provider request. This proves installed generation-change
recovery, not injected sequence-gap recovery or a Runtime-native interaction journey.

Installed sequence-gap recovery checkpoint on 2026-09-03 (`85e7e23`): the isolated P3 QA build
uses an eight-event router ring and exposes a QA-only action that pauses its Channel consumer,
generates read-only Pi reconciliation traffic through the official RPC surface, and reconnects from
the captured stale cursor. The production/default router capacity remains 2,048 and formal builds
do not expose this action. The signed installed candidate (main SHA-256
`ef3f4ef81ce1dd9ebc813eb07dd17c4d43dca854a49aa311e16714174bf78a83`) started Pi at
`20 / 20`, recovered the first explicit gap and discontinuity at `17 / 17`, sequence `41`, then
repeated the same recovery in the same process at sequence `62`. Both runs acknowledged the two
recovery revisions and left no pending reconciliation or parity mismatch. Inactive OpenCode state
was not incorrectly marked by the Pi-only transport gap. No prompt, permission response, or
Provider request was sent; formal `/Applications/Farfold.app` remained unchanged. This proves the
installed injected-gap gate, but not a real Runtime Turn or Runtime-native interaction journey.

Installed Runtime-native interaction checkpoint on 2026-09-03 (`d6f968a`): the isolated P3 QA
build loads a CLI-supplied Pi Extension that registers `/farfold-p3qa-confirm`; the command is not
loaded by formal builds. Pi's official `get_commands` result identified it as an Extension command
that runs without an LLM turn. Executing it in the signed installed candidate produced a native
`extension_ui_request` confirmation through the Host Channel, rendered Farfold's existing Pi
Extension dialog, accepted a negative reply through the generation-scoped InteractionRegistry, and
returned Pi's native rejection notification. Transport parity moved from `20 / 20`, sequence `20`,
to `23 / 23`, sequence `23`, with no unmatched events or pending reconciliation. Context remained
at zero and no Session JSONL was created, consistent with the documented local Extension-command
path rather than a Provider Turn. Formal `/Applications/Farfold.app` remained unchanged. This
passes the installed Pi-native dialog/reply journey; a real Provider-backed Turn is still open.

P3 closure checkpoint on 2026-09-03: with explicit authorization, the installed `d6f968a` QA
candidate sent `仅回复 FARFOLD-P3-TURN-OK，不使用工具。` through Pi 0.84.3 to Z.AI
GLM-5.3-Flash. The native Session records the exact user message and exact assistant response
`FARFOLD-P3-TURN-OK`, with stop reason `stop`, no tool call, and total reported cost
`0.00013035`. Host Channel/polling parity advanced from `23 / 23`, sequence `23`, to `46 / 46`,
sequence `46`.

The follow-up `885a7ca` commit removed all Pi/OpenCode event-polling calls and the temporary parity
fingerprint ledger from the frontend. The signed installed Channel-only candidate (main SHA-256
`1f6ac22c0624835bb83663b8718b7d1b8a2012d77e91341b751755831a4329e7`) reopened that exact Pi
Session and rendered the Provider response at sequence `20`; recovered an injected ring gap without
polling at `2` acknowledged revisions, sequence `41`; completed the Pi-native dialog round trip at
sequence `44`; and reopened exact OpenCode native Session `ses_f9c6fefa9ffeARsf3raAANPTXq` at
sequence `48`. Frontend format, typecheck, 16 files / 84 tests, production build, Rust format,
Clippy, and 97 Rust tests passed. Formal `/Applications/Farfold.app` remained unchanged and is not
promoted by this QA acceptance.

- build RuntimeEventRouter, LiveSessionProjection, SessionReconciler, InteractionRegistry, and
  UiTransport;
- run the new projection in shadow against current installed journeys;
- inject gaps, overflow, restart, malformed events, and stale interactions;
- remove polling only after parity and recovery evidence pass.

Exit: the new Host can reconstruct trustworthy Pi and OpenCode Session state and the UI no longer
depends on Runtime event polling.

### P4 — Unify Session, Project, Working Copy, draft, archive, and delete

Status: active.

Source implementation checkpoint on 2026-09-03 (`b276d84`, `d00d1c0`, `9580b35`, `fe71717`):
the Host store now exposes a transactionally consistent global SessionBindingIndex snapshot that
preserves every Runtime, installation, build, Adapter, connection, Project, Working Copy, Farfold
Session, and native Session identity. WorkingCopyManager exposes canonical-path truth and bound /
unarchived Session reference counts without claiming unchecked Git cleanliness. Per-Session drafts
are bounded, durable, foreign-key scoped, and acknowledged only after commit; title, pin, and
archive metadata update atomically, and archive does not remove a Working Copy or native Session.
Successful Pi/OpenCode discovery now registers only the actually version-and-digest-verified
managed Runtime build and connection in SQLite, idempotently and without accepting changed build
metadata. Frontend 16 files / 84 tests, production build, Rust format, Clippy, and 105 Rust tests
pass. No legacy JSON was migrated or deleted, no Runtime Session was imported, and no installed-app
acceptance or formal promotion is claimed by this source checkpoint.

Working Copy identity checkpoint on 2026-09-03 (`0827039`): a read-only registration preview now
uses Git's official `rev-parse` and `symbolic-ref` surfaces to resolve the checkout root, common Git
directory, root-versus-linked-worktree kind, and optional branch. Root and linked worktrees share a
stable Project ID while retaining distinct Working Copy IDs; detached HEAD is represented without a
branch. Existing Git markers fail closed when Git identity cannot be verified. Non-Git directories
remain valid Projects without fabricated Git state. The complete gate stack passes with 106 Rust
tests. This preview does not create, mutate, remove, or register a Working Copy.

OpenCode new-binding cutover checkpoint on 2026-09-03 (`70bd0a5`): frontend binding requests now
send only the native Session ID. The backend re-reads the exact Session through the authenticated
official OpenCode Session-list surface, verifies its active connection and Project, resolves the
Working Copy, and commits the full immutable binding to Host SQLite. The old JSON store is read only
and merged behind Host records for bounded compatibility; there is no dual write. The complete gate
stack passes with 16 frontend files / 84 tests and 108 Rust tests.

The clean commit was built, signed, installed, and launched as the isolated
`/Applications/Farfold P3 QA.app` candidate, main SHA-256
`c58f40f2b715bdc0b721334fdff9aa9d24e5b4c9eb6f12aad15c017a772d2e37`.
Opening exact native Session `ses_f9c6fefa9ffeARsf3raAANPTXq` through the installed UI started
OpenCode 1.15.13, rendered the immutable binding, reached Host Channel sequence `2`, and created one
SQLite Session row containing every required identity dimension. The legacy binding JSON remained
unchanged at SHA-256 `d5d656cbcf98a38f2f93c08c116970c3951ae76b21554f23f2ee472d1c46df77`
with its pre-run modification time. No prompt or Provider request was sent. Formal
`/Applications/Farfold.app` remained unchanged.

Pi new-binding cutover checkpoint on 2026-09-03 (`7064689`): schema v3 adds a Pi-specific native
Session locator without duplicating Adapter identity. The Host validates that the locator is a
canonical JSONL file inside Farfold's managed Pi Session root and commits it atomically with the
full immutable Session/Project/Working Copy binding. `runtime_remember_session` re-queries Pi
through a generation-correlated official `get_state`, verifies the native Session ID, Session file,
Project, and sanitized native history summary, and no longer writes `last-pi-session.json`.
Host-correlated internal Pi responses are consumed before UI event delivery, preventing a
`get_state` / remember feedback loop. Host SQLite is consulted first for resume; the old JSON is
read-only fallback until bounded migration. The complete gate stack passes with 16 frontend files /
84 tests and 112 Rust tests.

The clean commit was built, signed, installed, and launched as the isolated
`/Applications/Farfold P3 QA.app` candidate, main SHA-256
`5e6365794e897bc6b707b0187bce28d246a78accb9bfb0b937ab783146859993`. The installed UI started Pi
0.84.3 and opened exact native Session `01a063d1-6dfa-7015-b2eb-9411ad53850a`, with its prior
history rendered at Host Channel sequence `20`. SQLite migrated from schema v2 to v3 with a
pre-migration backup, passed `PRAGMA quick_check`, and contains one Pi locator plus the Pi and
OpenCode Session rows. After temporarily removing the legacy Pi JSON pointer, a full app restart
again opened the same native Pi Session from Host SQLite; the legacy file was then restored byte
for byte at SHA-256 `683de8368af4eead55619286d6e80281badb5dc5f3cf4bbbfde65af8b80fe1bf`
with its original modification time. No prompt or Provider request was sent. Formal
`/Applications/Farfold.app` remained unchanged.

Verified legacy activation checkpoint on 2026-09-03 (`c8d23f3`): the Pi pointer and OpenCode
binding sources are keyed by exact path and SHA-256 and are recorded as imported only after every
source record has a corresponding immutable Host binding created through the new official Runtime
validation paths. A partially verified source remains unimported and can be retried after a crash;
repeating a completed activation preserves its original `imported_at`. The legacy files remain
read-only and are not deleted at this checkpoint. The complete gate stack passes with 16 frontend
files / 84 tests and 114 Rust tests.

The clean commit was built, signed, installed, and launched as the isolated
`/Applications/Farfold P3 QA.app` candidate, main SHA-256
`9f788c747301eab71f21d09987cf70db6624dab8034531707475043374e4a9e6`. Opening the exact Pi and
OpenCode Sessions caused the corresponding source hashes to transition from no ledger rows to two
`imported` rows, each with record count one. Reopening OpenCode preserved both `imported_at` values,
two ledger rows, two Session rows, and one Pi locator. Both source files retained their prior
SHA-256 values. No prompt or Provider request was sent. Formal `/Applications/Farfold.app` remained
unchanged.

Durable attention source checkpoint on 2026-09-03 (`bee3624`): the Host now exposes a bounded
Session-attention snapshot and persists only Farfold Session ID, typed kind/status, Runtime
generation, native interaction ID, and timestamps. It never stores the Runtime-native permission
or dialog payload. OpenCode `permission.asked` is resolved through the exact immutable native
Session binding, successful response becomes terminal `closed`, and generation change or Runtime
termination becomes terminal `stale`; duplicate native events cannot reopen a terminal record.
Missing/archived Session bindings are not guessed. Pi Extension dialogs remain transient because
their current event does not carry a verifiable native Session ID; automatic Pi persistence is
deferred to the session-aware Host controller. The complete source gate stack passes with 16
frontend files / 84 tests and 120 Rust tests. No installed attention acceptance or Provider request
is claimed by this checkpoint.

Active Session restore checkpoint on 2026-09-03 (`d5082d0`): every Pi/OpenCode Session opened
through the official-validation binding path now updates the Session's monotonic `last_opened_at`
and the singleton last Project/Session restore pointer in the same immediate SQLite transaction as
the immutable binding and optional Pi locator. A locator conflict rolls back the new Session and
restore pointer together. The Host exposes this bounded restore state read-only for the later P5
controller cutover; React does not consume it yet. The complete source gate stack passes with 16
frontend files / 84 tests and 120 Rust tests. No installed acceptance or formal-app change is
claimed by this checkpoint.

Working Copy Git safety checkpoint on 2026-09-03 (`c657933`, `ea8b241`): OpenCode now holds its
OS-selected loopback port reservation until immediately before child launch, removing the prior
test and startup preparation race. WorkingCopyManager observes Git through the official porcelain
surface with optional locks disabled and reports only a fresh bounded summary: clean, dirty,
conflicted, not-Git, or unavailable, plus staged/unstaged/untracked/conflicted path counts. It does
not retain paths, diff content, or claim per-Turn provenance. The SQLite read transaction closes
before filesystem and Git observation. The complete gate stack passes with 16 frontend files / 84
tests and 121 Rust tests. No Git mutation, installed acceptance, or formal-app change is claimed.

Archive/restore consistency checkpoint on 2026-09-03 (`b6eb431`): archiving the Session named by
global restore state now atomically selects the most recently opened remaining unarchived Session
and its Project. If no Session remains, the Host clears only the Session pointer and retains the
Project context. Restore reads also suppress any historical pointer to an archived Session. The
complete gate stack passes with 16 frontend files / 84 tests and 122 Rust tests. This does not
delete a Farfold binding, Working Copy, branch, or native Runtime Session.

Fail-closed deletion preview checkpoint on 2026-09-03 (`1bfd0fa`): a read-only Host command now
builds a consistent per-Session impact preview covering Farfold metadata, draft bytes, durable
attention, native locator, Project/Working Copy sharing, and freshly observed Git safety. It states
that the native Runtime Session, Project, and Working Copy are retained. Unarchived Sessions and
open attention are explicit blockers, and execution remains disabled behind the unconditional
`active_turn_verification_required` blocker until a Session-aware controller can prove the absence
of an active Turn atomically. The complete gate stack passes with 16 frontend files / 84 tests and
123 Rust tests. No delete command, filesystem mutation, installed acceptance, or formal-app change
is claimed.

Portable Host metadata export checkpoint on 2026-09-03 (`54cb32c`, `5f9d44c`): the Host now previews and
creates a single-file, self-describing SQLite export through the online backup API. It records
format/schema versions, export time, bounded content counts, and an explicit inclusion policy;
Session titles, Project/native-locator/legacy-source paths, and draft bodies are included, while
Provider credentials, native Runtime history, diagnostics, and the not-yet-migrated LifeModel are
excluded. Staging uses `0600`, file and directory sync, integrity and foreign-key checks, SHA-256,
and same-directory atomic no-clobber activation. Import preview rejects ordinary live databases,
symlinks, count/policy/schema mismatch, and foreign-key damage. A reviewed import may be staged in
the canonical profile under its full expected SHA-256; copying is `0600`, revalidated after copy,
no-clobber, and idempotent for the exact same hash. Staging explicitly reports activation disabled.
Restore remains disabled until an exclusive stopped-profile activation/rollback controller exists.
The complete gate stack passes with 16 frontend files / 84 tests and 125 Rust tests. No real profile
export, import activation, installed acceptance, or formal-app change is claimed.

Cold-start portable restore checkpoint on 2026-09-03 (`7bf08f7`): after both managed Agent
Runtimes are fully stopped, the Host can now bind an activation request to the exact SHA-256 staged
artifact without mutating the live database. The next cold start processes that bounded intent
before Host storage or either Runtime opens: it revalidates the staged export, creates and syncs a
standalone rollback backup of the current database, constructs a clean candidate with the export
manifest removed, moves the database/WAL/SHM family inside the same profile, and opens the
candidate through the normal Host integrity/migration path. A failed post-switch smoke check
quarantines the candidate and restores plus reopens the original database; inability to prove that
rollback aborts application startup instead of silently continuing. An interrupted applying intent
and displaced database family are recovered before retry, while a pre-switch hash/format failure
leaves the live database untouched and is reported as rejected. The startup result is exposed as a
typed Host status. The complete gate stack passes with 16 frontend files / 84 tests and 128 Rust
tests, including successful cold-start activation, staged-artifact tamper rejection, and forced
post-switch rollback. This is source-only controller evidence: no real profile was exported or
restored, no installed-app acceptance occurred, and the formal application remains unchanged.

Archived Session metadata deletion checkpoint on 2026-09-03 (`c6c70d4`): deletion is now an
explicit preview-and-confirm Host operation, but only while both Pi and OpenCode lifecycle locks
prove that the managed Runtime processes are fully stopped. This deliberately avoids treating a
Runtime-wide activity projection or OpenCode's aggregate status surface as exact per-Session
active-Turn proof. The preview fingerprint covers the immutable binding, user-visible metadata,
archive/update timestamps, draft and attention revisions/counts, native locator presence, and
Project/Working Copy sharing. Execution re-reads that state inside one immediate SQLite
transaction and rejects a stale fingerprint, a mismatched typed Session confirmation, an
unarchived Session, or open attention. A successful delete cascades only Farfold-owned draft,
attention, and native-locator metadata; it retains the Runtime-native Session/history, Project,
Working Copy, repository, and files. The lifecycle locks remain held across the commit so a
concurrent Runtime start cannot invalidate the quiescence proof. The same exclusive guard now also
protects portable-import activation requests. The complete gate stack passes with 16 frontend
files / 84 tests and 130 Rust tests, including lifecycle-transition exclusion, stale-preview
refusal, cascading Host metadata deletion, and external/native-file retention. No real Session was
deleted, no installed-app acceptance occurred, and the formal application remains unchanged.

Project relocation checkpoint on 2026-09-03 (`35be773`): while both managed Runtimes remain under
the same exclusive stopped guards, the Host can now preview an explicit same-volume Project move.
The preview binds the stored Project and every Working Copy ID/path/update revision to macOS
filesystem device/inode identity. After the user moves the directory outside Farfold, activation
requires the selected replacement Project and every derived or external Working Copy path to
resolve to those same filesystem objects, rechecks the database snapshot, and updates only the
Project/Working Copy canonical paths in one immediate transaction. Stable IDs and all Session
bindings are preserved. A copied directory, different filesystem object, symlink, missing Working
Copy, stale preview, path uniqueness conflict, or concurrent Runtime transition fails closed.
Farfold does not move/copy a directory or run a Git mutation. The complete gate stack passes with
16 frontend files / 84 tests and 131 Rust tests, including an actual temporary-directory rename,
stale-state rejection, ID preservation, and different-directory rejection. No user Project or
Working Copy was moved, no installed-app acceptance occurred, and the formal application remains
unchanged. Per-Turn Changes review remains in P7 because P4 does not yet have defensible Turn-to-diff
provenance; no placeholder review state is invented here.

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

P0 through P3 are complete. P3 closed after a real Pi/Z.AI Turn, installed Channel-only Pi and
OpenCode Session recovery, injected-gap recovery, a Runtime-native interaction journey, and removal
of frontend Runtime event polling. P4 is the only active implementation phase. Its source-only
foundation now includes global binding and Working Copy snapshots, durable drafts and Session
metadata, registration of verified Pi/OpenCode installations, installed new-binding activation for
both Pi and OpenCode through official Runtime validation, installed idempotent copy-verify
activation of the remaining legacy Pi/OpenCode binding sources, and atomic global last
Project/Session restore state. Working Copy snapshots now include fresh bounded Git cleanliness and
conflict truth without path/diff disclosure or per-Turn attribution, and archiving the active
restore target atomically selects an unarchived fallback. Archived Farfold Session metadata can now
be deleted only after a bound preview plus typed confirmation while exclusive lifecycle guards
prove both managed Runtimes fully stopped; native Runtime history, Projects, Working Copies, and
files remain untouched. A self-describing portable Host metadata export, fail-closed import
preview, and SHA-bound pending import staging now exist. The exclusive stopped-profile cold-start
controller now creates a rollback backup, activates only a revalidated staged artifact before
Runtime startup, recovers an
interrupted switch, and fails application startup when rollback cannot be proved; it has source
tests but no installed-app or real-profile acceptance yet. Same-volume Project relocation now
preserves stable IDs only after exact filesystem-object and stale-preview verification; Farfold
does not perform the filesystem move. Per-Turn Changes review stays in P7 until provenance is
defensible. Next, close the remaining P4 legacy-retirement and Pi attention decisions, retaining
the read-only legacy files until explicit retirement and rollback acceptance. Durable OpenCode
interaction attention is now source-accepted; Pi attention awaits exact Session-aware controller
identity. The restore state remains a Host API until P5 replaces the existing frontend lifecycle
owner. Do not
dual-write, replace the formal installed app, delete profile data, or move the UI onto incomplete
authority before the migration, transaction, rollback, and installed recovery gates pass.
