# Codex ACP E foundation

Current maintained version: 0.1.5. Production login, model admission, thread mutation,
Turn, history task entry, interactions and steer are hard-disabled; no environment override enables them.
`test/synthetic-adapter.mjs` injects only the no-network synthetic server.

The ordinary Tauri `host_codex_acp_workspace` facade now reads only shared Host
bindings and safe cached connection/configuration/model/Turn state. It does not
launch, authenticate, refresh a catalog, open a native thread or admit a task. Its
capabilities are hard-closed. The existing CodexWorkspace routes saved Sessions by
adapter ID; old direct Sessions retain their original path, unbound/new ACP pages
are unavailable, and ordinary Host open explicitly blocks ACP without fallback.
This is a minimal routing/state slice, not a complete task/authentication UI: native
Configure instructions, catalog selection, transcript events, approvals/Plan questions,
Stop and steer commands still require reviewed view/facade integration. No production
test switch or enabling environment variable was added.

`admission.mjs` adds synthetic fresh account/read and complete model/list pagination
(includeHidden, 32/page, at most 16 pages/512 models and 256 KiB). Duplicate IDs,
cursor loops, malformed entries and partial catalogs fail closed. Display preserves
catalog ID versus native model string, hidden/default, reasoning options/default and
input modalities. Account identity remains private; public observations carry only
the account kind/auth requirement plus full launch scope and epoch. Account events,
configuration attempts, changed catalog or generation invalidate selection; login
completion/credential commit never admits work. No catalog/account is persisted.

A caller explicitly chooses a visible catalog ID, expected provider and supported
effort using the original scoped catalog receipt. The catalog does not identify the
provider; the caller must supply it, not infer it from the model name. Synthetic
thread/start maps to native model/modelProvider and config.model_reasoning_effort,
with allowProviderModelFallback=false. Its actual model/provider/effort must match.
The shared Session's immutable native_model_selection_json stores this confirmed
choice, original runtime/profile/thread/tree/Working Copy identity, not credentials
or another model catalog/table. A failed metadata commit leaves task admission closed.

Fixed thread/read only confirms identity/provider/idle, not model/effort. Cold open
first reads the original thread, then resumes it without model/provider/config
overrides; actual resume values must match saved metadata and the current catalog.
Missing metadata, default fallback and changed values remain blocked. A loaded
connection uses its previously checked start/resume snapshot, with fresh account,
catalog and thread identity/idle reads before every Turn and again before native
dispatch. A model-settings change invalidates the actual snapshot itself; selecting
the old value cannot revive it. This is not Runtime-internal model CAS or an account
guarantee. Per-Turn actual provider/model uses the existing shared native_observation
branch of turn_provider_bindings; it never creates managed verification. Real
authenticated profile restore and all model/Turn mutations remain disabled.

`turns.mjs` uses fixed 0.143.0 turn/start and turn/interrupt with native thread/Turn
IDs. Early notifications wait for the native start receipt; item IDs come only from
native lifecycle envelopes. Farfold Session/Host Turn, tree ID, Working Copy and
the full launch scope remain separate. Host admission uses TurnCoordinator and
AcpSessionOperations::Turn; verified projections use the shared RuntimeEventRouter
and its existing observers. No second Agent loop or direct Codex fallback is used.

Assistant text and reasoning delta/item fields are positively validated. Ordinary
command/file-change events project native ID/type/status only. Synthetic approvals
add necessary typed command/cwd/reason/options/permissions and, when available, a
bounded matching native file-item diff preview; this grants no Host file ownership
or command execution. Raw output/errors/unknown fields stay private. Unknown item kinds do
not become state signals. A terminal with unresolved known item lifecycle fails
closed. Interrupt ACK never releases occupancy; only the original native terminal
does. Timeout/disconnect retains unknown reservations, with no retry or timeout
change. Later operation replies cannot mutate a new Turn.

`interactions.mjs` supports synthetic command/file native choices and Plan-only
requestUserInput using exact original JSON-RPC request IDs (including numeric versus
string identity). The shared Host registry owns reply availability and one-shot
responses; no separate registry or old direct controller is used. Sent remains
Responding until correlated serverRequest/resolved; Stop, expiry, terminal and mode
change withdraw local reply availability without inventing a native answer. Question
cancel has no independent fixed response: use original-Turn interrupt, not empty answers.
Plan is a fresh same-thread settings notification observed during the current Turn,
not a native mode CAS or model/account admission. Default questions stay disabled.
Native grantRoot semantics are unstable; persistent file authorization is not guaranteed.

Synthetic turn/steer sends expectedTurnId only to the original active Turn; ACK does
not mean execution, completion or a follow-up task. Duplicate operation IDs, Stop,
late replies, foreign identities and unknown outcomes fail closed. Pending interactions
can coexist with steer, and an in-flight steer does not block original-Turn Stop.

Synthetic cold open follows the existing fresh list/read/resume identity checks,
then thread/read(includeTurns=true). Only complete terminal history (up to 64 Turns,
256 items each) is projected; missing/partial/active history is blocked. This is a
read, never a resend. Automatic reconciliation/release of an unknown reservation
across connection generations is still unavailable. Real account/model admission,
background execution capability coverage and operational ordinary UI remain unimplemented.
Run `node --test test/*.spec-node.mjs` for Node contracts.

Shared Host schema 15 adds subordinate launch metadata and persistent generations
to the existing owned-profile authority. HOME/CODEX_HOME paths and filesystem
identities, fixed installation/interpreter/modules, cwd/Working Copy and a private
process-lifetime lease are checked. Restore never recreates missing directories or
imports defaults. Production restore still rejects auth.json/config.toml/sessions.
The unpersisted fresh launch helper is test-only.

The shared Session control ID is native thread.id. The existing shared locator
authority adds codex_tree_session_id for opaque thread.sessionId, not a file path.
Host synthetic registration/open requires fresh list/read and the persisted ID pair,
profile/build/workspace scope. Native rollout path is checked on observation but
is not the stable control identity. Existing Pi file locator behavior is preserved.

`threads.mjs` projects only validated metadata from thread lifecycle replies and
thread/started or thread/status/changed events; it does not expose message bodies,
Turns, approvals or unknown raw fields. Authentication, generic errors and unknown
envelopes remain private. `events.mjs` retains original JSON values in connection
memory (128 envelopes / 1 MiB); overflow fails closed, never silently drops for
continuity. No Host read/tool exposes this buffer; it is not durable history.
This replaces the earlier blanket post-auth discard, not a complete task-event map.
Use `node --test test/events.spec-node.mjs` for its isolated Node contract.

Farfold-maintained independent process boundary. ACP protocol version 1 is handled
by a small JSON-RPC dispatcher, without an external ACP SDK dependency. The Host
uses the existing shared `AcpTransport` and initialization service. Native App Server
I/O exists only inside this new adapter; no Agent loop is implemented.

`manifest.json` pins the interpreter, adapter entry, core/configure/thread/event/turn/interaction/admission modules and
official Codex binary. Both Host and entry recheck module hashes before execution.
`FARFOLD_CODEX_ACP_LAUNCH` contains only
explicit non-secret paths and full scope. Each production launch requires a registered
0700 owned home and its original `codex` child; this slice rejects existing native
authentication/config/history and does not import the user's default Codex domain.

The production entry enables ACP `initialize`, `_codex/account/read` (unauthenticated),
the empty-list probe and metadata-only `_codex/thread` reads. `_codex/thread/event`
contains validated lifecycle metadata, never unknown native envelopes. Scope includes product,
installation, native build, adapter ID/build, connection, profile and generation.
Transport failure/timeout closes the connection; unconfirmed thread operations block
further admission until disconnect. Explicit local rejections do not invent unknown
native mutations. No retries or fallback. Egress is disabled
for this engineering slice. Native browser/API-key/device-code types are recorded,
but real login and tasks remain unavailable, as do session/load/prompt/cancel controls.

Version 0.1.1 introduced shared Host lifecycle and connection-level Configure occupancy
without inventing a native Session. `core.mjs` and `configure.mjs` implement an
ephemeral browser/device/API-key/cancel/logout state machine. Production passes
`authenticationEnabled: false` with no environment override. Only the test entry
injects a no-network synthetic App Server and enables Configure. Synthetic success
is not real credential acceptance, model verification, or installed readiness.

Keys use typed stdin payloads only, never argv/env/events/DB/logs. Login URLs and
device codes appear only in temporary operation responses. Scope/generation and
operation/request/login IDs guard replies; canceled API-key outcomes remain unknown
even after a late commit. Fresh account observations may invalidate an earlier
confirmed status without rewriting that completed operation. No retries or rollback
guarantees are implied.

All account notifications stay private. Version 0.1.2 replaces post-auth blanket
discard with the bounded private channel and validated thread metadata described
above. Complete task-event mapping and authenticated profile admission remain open.
The status-label contract is not a registered Tauri/workbench flow.

This is not a complete ACP Agent, an ordinary Tauri UI connection, or installed E
acceptance. The old Codex controller is not called by this module. Old source paths
must not be deleted on the basis of this narrower read-only parity.

Native authority: generated 0.143.0 stable/experimental JSON schema and TypeScript;
the current [App Server guide](https://developers.openai.com/codex/app-server/) is
background only. A fresh schema/control probe lives in `scripts/codex-boundary-probe.mjs`.
Detailed execution evidence belongs to the existing implementation record.
