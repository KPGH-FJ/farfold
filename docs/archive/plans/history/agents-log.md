# AGENTS Active Sequence 日志（历史档案）

> 由 2026-09-18 片 0 归档：AGENTS.md 原 "Active Sequence" 节（55-793 行）。仅作证据保留。

---

## Active Sequence

2026-09-16 USER PAUSE: pause development now due to remaining usage budget.
The preceding read-only history/content slice passed coordination review (25/25 FE,
12/12 Rust Turn facade). The newly authorized Composer send/Stop slice has NOT been
implemented. Only its entry documentation and one deterministic expected-failure source
regression for the missing ACP transcript scroll dependency were added; no production
code changed in that slice. Resume here only after the user resumes development: first
fix the reproduced scroll gap, then implement the approved bounded Composer scope below.
The `.fails` test records an unresolved gap, not a successful repair. No full test/build,
real Runtime/profile/model or application/data change is required merely to pause.

2026-09-16 history/content coordination review passed (frontend 25/25, Rust Turn
facade 12/12). Continue only the finite Composer send/active Stop static-mock slice,
reusing the existing workspace, shared Session drafts, typed backend/Turn facade and
Host event pump. Production gates/capabilities stay closed; no env/URL override.
One dispatch, duplicate exclusion, original scope/Session/Turn and retired receipts
must preserve subsequent draft edits. Stop ACK is requested, never settled; closing
or returning neither stops nor resends. First reproduce ACP follow-scroll omission,
then minimally restore following without pulling users who scrolled upward. No reply/
steer, real profile/native/account/model, install/existing DB/Adapter/schema/pin or old
controller changes. Record failures/tests in the existing record and submit for review.

2026-09-16 read-only history/safe live content is implemented for coordination review.
The existing single CodexTranscript consumes a separate typed ACP presentation, using
original read_turn_history and non-consuming shared router snapshots with a before-read
cursor. Scoped sequence deduplication, bounded buffers and retired-read guards keep
Session/generation changes from reusing old content; missing continuity/details remain
explicitly incomplete. Historical Host Turn IDs are unavailable, not fabricated.
Frontend 406/406, scoped Rust 67/67, production lib Clippy/type/format/diff pass; real
component static mocks cover output, close/return, gap, terminal history and late history
after switching Session, with Direct binding/draft regression preserved. Three initial
frontend failures and their narrow fixes are recorded. All Composer actions and production
gates stay closed. No real Runtime/profile/account/model, existing DB, install, production
Adapter/schema/pin or old-controller change occurred. First profile/real restore,
production async scheduling, reply/steer and installed acceptance remain pending.

2026-09-16 Turn facade/Host event consumption passed scoped coordination review
(frontend 14/14, Rust facade 11/11). Next finite slice is read-only history/typed
events into the existing single CodexTranscript and backend/view, not Composer actions.
Reuse read_turn_history and non-consuming shared router snapshots. Match original
scope/Session/thread/tree/Turn/item identities and bounded sequence; duplicates do not
duplicate content, gaps/disconnect/generation changes never imply complete history or
task settlement. Report missing command/output/diff truthfully; no fake Direct DTO,
second reducer/page, persistent event ledger, replay, or UI drain. All production gates
and capabilities remain false; only cfg(test)/static mocks, no real profile/native/account/
catalog/model, existing DB/install, production Adapter/schema/pin or old-controller changes.

The 2026-09-16 closed Turn facade/Host event-consumer slice is implemented for review.
Send/active Stop use original shared Session and Turn authorities, with native-observation
model binding and existing capacity/WC exclusions. One connection-owned shared ACP pump
consumes the existing validated event path without UI reads; other drain paths reject.
Early events wait for checked receipt identity, Stop ACK does not settle, and failure or
retirement retains original unknown occupancy. Existing interaction routing is preserved;
no reply/steer or transcript UI is enabled. Frontend 392/392, E/shared Rust 145 passed with
5 existing ignores, Pi/OpenCode 64 passed with 17 existing ignores, Node 23/23; final
facade 11/11, production lib Clippy/type/format/diff pass. Test-fixture first failures and
fixed protocol observation limits remain recorded. Production gates/capabilities stay
closed. Real native scheduling, first profile/restore and installed acceptance remain open;
the synchronous synthetic facade is not production async scheduling. No production Adapter,
schema/pin, existing DB/app or old-controller change; only its synthetic server fixture changed.

2026-09-16 final navigation follow-up passed coordination review (independent frontend
13/13 and preceding Rust focus 6/6). Next authorized finite slice: typed shared-Host
Turn send/active Stop and Host-owned terminal event consumption, Rust facade and
necessary backend contracts first, synthetic no-network only. Reuse start_turn,
interrupt_turn, poll_turn_events, TurnCoordinator, occupancy and RuntimeEventRouter;
one connection event consumer must settle without UI reads. Stop ACK is not terminal;
unknown retains occupancy. No reply/steer, full history/UI, first profile/real restore,
production scheduling claim, schema/Adapter/pin or installation changes. All production
gates/capabilities stay closed. Report before a material event-pump rewrite.

The 2026-09-16 final activation follow-up is implemented for review. Two current=true
counterexamples (a different Session and the same Session with a newer timestamp)
first failed, then passed after exact comparison of final raw navigation with the
focus receipt's committed tuple. No older snapshot is applied, no valid commit is
rolled back, and no focus/native retry or token refresh occurs. Targeted frontend
entry/metadata tests pass 13/13. This is synthetic-only; production stays closed.

2026-09-16 final activation review requests one narrow frontend follow-up: if the
post-focus context already observes another raw navigation tuple (including a newer
timestamp for the same Session), do not apply the older committed navigation snapshot.
Reproduce with current=true, then compare the final raw tuple exactly to this focus
receipt. No rollback, token refresh, repeated focus/native call or new navigation system.

The 2026-09-16 persistent-focus guard correction is implemented for coordination review.
ACP focus now uses the hard-closed operations facade, never unguarded host_session_focus.
Raw app_state expectation (absent versus nullable present row) is captured before native
start/open, not refreshed from its late receipt. The original shared Immediate mark-opened
transaction compares that token, stored target/immutable model/owned generation and launch;
the original controller/connection locks hold current scope/native pair/actual through commit.
Conflicts write neither app_state nor last_opened; original Pi/OpenCode/Direct no-guard
semantics remain. No schema/counter/new navigation state machine or compensating write.
Original red test is green; shared-store/Runtime/E tests pass 242 with 22 existing ignores,
frontend 382/382 and production lib Clippy/type/format/diff checks pass. No real data/profile/
native/account/model/install or Adapter/pin change. This guards Host-observed conflicts only,
not user intent not yet delivered to Host. A valid commit before a later intent remains a
valid ordered fact; late UI receipts still retire. Submit before further activation work.

2026-09-16 coordination did not approve complete Session activation: post-commit JS
focus validation cannot protect persisted restore state. Only a minimal follow-up is
authorized: reproduce the late-focus overwrite, add an optional typed guard inside
the existing shared mark-opened Immediate transaction, and route ACP focus through
the hard-closed operations facade. Compare original raw app_state including absence;
check current scope/handle/native pair/model and persisted owned generation before
commit through existing authorities. No schema/counter/navigation state machine or
compensating writes. Unguarded Pi/OpenCode/Direct semantics stay unchanged. Guard only
Host-observed conflicts, not undelivered UI intent; all production gates remain closed.

The 2026-09-16 closed Session-entry/navigation slice is implemented for coordination
review. The existing CodexWorkspace/SessionStartPanel reuse persisted installation and
WorkingCopy selection, private current model choice, and a new read-only exact owned
launch projection. It never creates/restores a profile. One typed start/open receipt is
rechecked against shared navigation, original tree/model and fresh scope before visible
activation; no second native open, fabricated Direct DTO or draft transfer. Model edits,
view/workspace/scope changes retire late results. Production capabilities remain false;
only the static mock component fixture operates controls. Frontend 380/380, E operations/
workspace/thread 44/44 and production lib Clippy pass; final shared-opening text reuse
has targeted 22/22 plus type/format/diff checks. No Adapter/schema/pin, real Runtime or
profile/account/model, existing DB, install or old-controller changes. First profile,
real launch/restore scheduling and Turn/history/event/reply/Stop/steer still remain.
Shared focus is metadata, not a native/SQLite atomic CAS; rejected late focus receipts
are not applied to the view, but do not roll back an already committed focus metadata
write. Submit this bounded contract and limitation for review before another slice.

2026-09-16 coordination passed workspace admission (independent 6/6) and authorized
only closed Session-entry/shared-navigation wiring in the existing workspace. Reuse
stored Project/WorkingCopy selection, exact current owned scope/launch relation and
current explicit choice. Re-read shared persisted binding after the typed receipt,
then activate via original navigation without a second native start/open. Retire
late results on Session/workspace/generation/choice changes; preserve drafts and Direct.
Only static mock IPC may operate controls; all production gates/capabilities stay false.
No first profile, real Runtime/restore/auth/catalog/model/task, install, schema/Adapter/pin
or Turn/history/event/reply/Stop/steer work. If shared navigation needs a material rewrite
or another workspace authority, stop at a small wiring layer and report the exact gap.

The 2026-09-16 workspace-admission follow-up is implemented for coordination review.
Real temporary Git root and external linked worktree controls remain valid without
managed rows. Existing managed rows must have worktree/ready, matching project/branch
and a distinct same-project source; removal records reject admission. One transient
workspace projection retains observed source metadata, so an in-flight managed row
cannot disappear or change before atomic registration without rejection/unknown.
This is not a persisted managed marker or inference about absent historical records.
Six new synthetic tests and related operations/thread/store regressions pass 61/61;
production lib Clippy, Rust 2024 format and diff checks pass. First failures remain
documented. No frontend, Adapter/schema/pin, real Runtime/profile/model, existing DB,
installation or old-controller change. Production gates stay closed; await review.

2026-09-16 coordination clarified that external worktrees without managed metadata
remain valid; Worktree does not imply managed. Restrict only existing managed rows to
worktree kind/ready/consistent recorded ownership and branch, with no removal. Verify
real temporary Git root/linked controls plus pre-start rejection and post-start drift;
no new managed marker, missing-history inference or Git-availability policy expansion.

2026-09-16 Session facade review is paused for a bounded workspace-admission check.
Coordination passed frontend 11/11 and operations 21/21, but requests temporary-store
tests for missing/non-ready managed metadata, root/managed conflicts and removals.
Actual schema kinds are root/worktree; external linked worktrees also use worktree,
so absence of managed metadata is not intrinsically corruption. Verify the intended
closed-E admission boundary before restricting legitimate external worktrees. No
worktree-platform rewrite, schema, user-data repair, real Runtime or installation.

The resumed 2026-09-16 Session facade slice is implemented for review. The sole typed
Host operation accepts start with stored WorkingCopy ID/current explicit choice, or
open with original Farfold Session ID only. It reuses native thread lifecycle and atomic
registration, deriving Host IDs through the shared helper; existing workspace metadata
is rechecked inside the registration transaction. Refresh clears Host choice even when
the Adapter retains its own selection. Retired/unknown results never start replacements.
Typed client/backend guards are connected, but ordinary controls/capabilities stay closed;
no Workspace page or Session activation/navigation path was added. Frontend 372/372,
combined shared-store/Runtime tests 229 passed/22 existing ignores, final targeted 39/39
and production lib Clippy pass. No Adapter/schema/pin, real Runtime/profile/account/model,
existing DB or install change. First profile, production scheduling, UI activation and
Turn/history/event/reply/Stop/steer remain separate subsequent work after review.

2026-09-16 atomic-registration repair passed independent coordination review (threads
11/11 and shared records 7/7). Resume only the previously approved synthetic Session
facade slice: existing owned connection, stored Project/WorkingCopy IDs, current explicit
choice and matching actual native model/provider/effort; original opens resolve Host
Session ID without overrides or Turn replay. Reuse repaired registration/unknown guards.
No new Session state machine, production gate/UI activation, real Runtime/profile/model,
first profile, async production scheduling, Turn/history/events or installation work.

The 2026-09-16 atomic Session registration repair is implemented for review. Codex now
writes immutable model selection inside the existing shared Immediate transaction with
Session/locator/Project/WorkingCopy, reusing a transaction-scoped target/model helper.
Legacy no-selection APIs keep their behavior. Preparation errors do not poison the
connection; post-start storage/transaction errors retain bound identity/actual evidence
and set threads.unknown. Rejected admission cannot erase that diagnostic; all subsequent
work is blocked, Stop remains allowed. Original regression is green; 6 additional tests
cover rollback/conflicts/scope/generation/idempotence and rejection. A combined shared
store, Pi ACP, OpenCode ACP, old Codex Session and E run passed 221 with 22 existing
ignores; production lib Clippy/format/diff pass. No schema/Adapter/pin/real data/install
change or cross-process orphan recovery. New Session facade still waits for this review.

2026-09-16 coordination independently reproduced the registration red test and approved
only its minimal repair. Include immutable model selection in the existing shared
Immediate registration transaction; reuse validation helpers, preserve no-selection
Runtime semantics, and add no table/schema/registration state machine. Transaction
failure after native start must preserve bound identity/selection and set existing
threads.unknown, blocking further work while allowing Stop. Preflight rejection remains
distinct. Test rollback, immutable conflicts, scope/generation, idempotence and rejection
after failure, then shared-store/Runtime/E regressions. Cross-process orphan recovery is
not claimed. Keep the new Session facade paused until this repair passes review.

2026-09-16 Session facade work stopped at the authorized atomic-registration gate.
A deterministic temporary SQLite trigger makes model metadata UPDATE fail after native
start: existing register_thread has already committed Session+locator, leaves selection
missing, and leaves thread unknown=false/operation pending=false. The original native
identity remains bound. New regression intentionally fails (0/1); original lifecycle
test 1/1 and operation facade 13/13 pass. Only the test and documentation changed;
no new facade/UI/production behavior. Review the shared transaction and original-identity
failure boundary before continuing; do not retry start or invent another state machine.

2026-09-16 Refresh/Select coordination review passed (frontend 19/19, operations
13/13 independently). The next finite slice may expose synthetic new/open Session
contracts through the same Host facade, using existing threads/register/open and shared
Project/WorkingCopy/locator/immutable selection authorities. New Session must carry its
current explicit choice; retained Adapter selection is not user consent. Read original
metadata by Host IDs, never trust UI cwd/thread/tree. Production gates stay closed;
no Turn/history/interactions, first profile, real Runtime/profile/account/model, database
migration, install or Adapter/schema/pin change. If registration is not atomic or failure
recovery cannot preserve unknown identity, first prove and report the gap; do not create
a new state machine. Submit review before expanding scope.

The 2026-09-16 admission Refresh/Select view slice is implemented for coordination
review. It reuses the existing Host admission/Configure authorities and shared model
fields; full scope/epoch/hash/catalog/native-model/effort/expected-provider checks
reject stale choices, Configure pending/Unknown and bound-Session edits. Refresh
never restores a choice; failures clear current availability. The private projection
omits actual model/thread evidence and grants no task readiness. Frontend 366/366,
broad E Rust 61 passed/5 explicit ignores, final operation tests 13/13 and production
lib Clippy pass; broad E preceded the last added operation test and enum boxing.
Production gates/capabilities remain closed, with actionable controls only in a static
mock fixture. No Adapter/schema/pin, real profile/account/catalog/model/task, existing
database or installed application changed. Await review before another finite slice.

2026-09-16 lease fixture review passed (coordination exact test 1/1). The next finite
slice wires existing admission Refresh/Select into the same typed operation facade
and existing model controls, synthetic/mock only. Bind full scope/epoch/catalog hash,
visible model/native ID, effort and explicit expected provider; reject Configure
pending/Unknown, generation drift and immutable bound-Session edits. Failure clears
current availability; account/selection never implies actual model or task readiness.
Only refresh/select are exposed, not restore/preflight/thread/Turn. Reuse admission
and shared occupancy, with no new Provider table or state authority. Production Host,
Adapter gates and UI capabilities stay closed. No Adapter/schema/pin, first profile,
real restore/startup/account/catalog/model/task/install changes. Submit for review.

The bounded 2026-09-16 lease diagnostic proves the shared-process test premise was
invalid: drop in the parent does not remove a pre-exec child's inherited flock
reference even with CLOEXEC. One fixed 128-sample ordinary-spawn probe reproduced
15 EWOULDBLOCK failures with valid metadata. The original failing run's child PID
was not captured. Only the lease assertion fixture now runs as one exact test in a
fresh exec process, creating its lock afterward; all assertions remain unchanged,
and the parent checks that one test actually ran. No unlock/retry/timeout or Runtime
lease semantics changed. One wider E regression passed 59 with 5 explicit ignores
(3 real Runtime checks plus 2 opt-in diagnostics). Original 58/1/3 is preserved.
Await coordination review; no next feature, real profile/native/login or installation.

2026-09-16 coordination approved only a bounded lease-test diagnostic follow-up.
Preserve the E 58/1/3 result; capture exact metadata/flock errno and sample only
temporary test files and owned child processes. No retry-to-green, timeout increase,
weaker assertions, explicit unlock workaround, real profiles or user process stops.
A deterministic test-fixture defect may receive a minimal fix; changes to production
lease/Runtime safety semantics require an evidence-backed decision first.

The 2026-09-16 same-process Configure discovery/reattachment slice is implemented
for review. Private reads derive bounded kind/operation/login/phase/in-flight data
from the existing Host Flow under shared occupancy locks; no new state authority.
Reentry closes starts until no-operation or fresh original status is confirmed.
In-flight discovery waits for explicit recheck; unknown or missing identities block.
Instructions are returned only by fresh status, never discovery or cached views.
Frontend 352/352, Host operations 10/10 and Configure targeted checks pass; broad E
Rust had 58 passed/1 lease-test failure/3 ignored. The isolated lease diagnostic
passed, but the original failure remains unexplained and its path was not changed.
Production remains hard-closed; no Adapter/schema/pin, real profile/native/account,
model, application install or existing data changes. Await coordination review.

2026-09-16 Configure UI/client coordination review passed. The next finite slice is
same-process, same-connection pending Configure discovery and reattachment through
the existing private Host control/occupancy authority. Test leave/background/return,
late generations and discovery/start races first. Reentry blocks starts until Host
confirms no operation or the exact original operation is freshly read. Unknown kind
or identity blocks; never infer browser, reuse cached instructions or auto-retry.
Production capabilities/gates remain closed; only cfg(test)/static mock fixtures.
No Adapter/schema/pin/profile/native/account/install changes, auth history table or
second state machine. Process restart/first profile/real cold restore are outside.
Submit this finite slice for review.

The 2026-09-16 private Configure presentation/client slice is implemented for
review. Existing CodexWorkspace uses its typed backend and CodexConnectionPanel;
ACP inner controls reuse ProviderAuthPrompt and the established auth styles. Private
receipts check full scope, operation/login IDs and non-revival; leave/reconnect drops
instructions and stale replies without claiming native cancellation. Production ACP
capabilities remain false and expose no login/key controls. Only a separate browser
mock fixture exercises forms and temporary URL/code display, without navigation or
native access. Frontend 339/339, typecheck/format, Host operation 8/8 and real-component
mock checks pass. This does not add first-profile setup, real restore/scheduling,
operational login, catalog/models/tasks or installation. Submit for coordination review.

2026-09-16 Host operation facade coordination review passed (operations 8/8).
The next finite slice may wire private ephemeral Configure UI/contracts inside the
existing CodexWorkspace backend/view boundary, reusing account/auth components.
Validate scope/operation/login identity, cancellation/unknown outcomes and view or
connection retirement with no-network mock-IPC real-component checks. Production
ACP capabilities stay closed; URL/code/key controls may be exercised only in mock
fixtures, never via a production enable switch or automatic browser opening. No
secret/instruction persistence/events, account-to-model readiness inference, schema,
Adapter/pin changes, native/profile access, new production gate, install or old-path
deletion. First profile creation, real restore/scheduling, catalog/models/tasks remain
later slices. Submit this finite UI contract slice for coordination review.

The 2026-09-16 typed Host operation slice is implemented for review. One registered
command covers original owned-profile restore, scoped connection Stop and Configure,
but unconditionally rejects in production before state lookup/profile access/native
launch. Only cfg(test) admits synthetic dispatch. Restore resolves paths from shared
saved metadata, checks the original generation again under the original lease, and
uses existing Runtime/HostSessionController. No fresh-profile creation or UI action
is enabled. E Rust 56 passed/3 ignored, targeted frontend 17, typecheck/clippy/format
pass. Adapter/schema/pins, installed apps and existing data remain untouched. Auth UI,
new-profile setup, catalog/model, thread/Turn/history and interaction wiring still
require later slices; this is not authenticated/installed E acceptance.

2026-09-16 coordination approved the next finite E slice: typed Host operation
facade/command registration for the existing owned connection/profile lifecycle and
Configure services, with no-network synthetic IPC contracts. Reuse Runtime and
HostSessionController; no second state machine. Production commands must reject
before native launch, profile/credential access or any other side effect. Injection
is test-build-only, never an environment or frontend bypass. Preserve full scope,
lease/generation, Configure occupancy, cancellation/late/unknown semantics and
ephemeral private authentication payloads. Adapter/schema/pins, real profile/native
launch/login/model/catalog, installation and old-controller deletion stay closed.
Submit this bounded slice for coordination review before further workbench wiring.

The 2026-09-16 E typed backend/view facade finite slice is implemented for
coordination review. The existing CodexWorkspace now selects one typed backend
from the persisted adapter binding; old Direct commands and DTOs are mechanically
wrapped, while ACP consumes only the prior closed snapshot plus bounded typed event
summaries. Session/scope/thread/tree/Turn/request identities, view lifetime and ACP
read cleanup reject stale results without fallback or re-showing a prior snapshot.
ACP actions remain unavailable. Its closed interaction
projection strips raw command, cwd, path and diff fields before the shared panel; Direct
interaction payloads are unchanged. Frontend 326/326, Pi Adapter 192/192, Codex Node
23/23 and E Rust 48/48 with 3 explicit ignores pass; type/format/diff checks pass.
No Adapter/schema/Rust production mutation, login/model/native request, build/install,
existing database migration or old controller deletion occurred. This is still not an
operational ACP workbench: production Host wiring for authentication, catalog/model,
thread/Turn/history and reply/Stop/steer remains before user-present real acceptance.

The 2026-09-16 minimal closed facade passed coordination review (frontend 16/16,
Rust workspace 4/4 independently). The next finite slice may extract a small typed
backend/view facade inside the existing CodexWorkspace, mechanically wrapping old
direct operations and displaying safe ACP state/events with all ACP actions closed.
Reuse the single transcript/interaction presentation; do not copy a page or reducer.
Persistent binding and original request/Turn identities govern every operation;
stale results never fall back. No new mutation registration, credentials UI, native
requests, adapter/schema changes, installation or old controller changes. If this
requires a rewrite, stop at the minimal view-model mapper and report the Host gaps.

2026-09-16 E ordinary-workbench work stopped at the explicitly permitted minimal
facade/state layer for review. `host_codex_acp_workspace` reads the shared owned
Runtime's safe cached state only; no launch/auth/model/Turn command is registered.
The existing CodexWorkspace selects by persisted adapter ID, keeps direct Session
open/task/UI code, and shows new/ACP Sessions as unavailable without fallback.
Operational authentication, catalog selection, transcript/interaction/Stop/steer UI
remain unwired because the old DTO/control coupling needs a reviewed extraction.
Do not describe mock routing/state checks as complete workbench or installed E
acceptance. Production gates, installed applications and schema14 data are unchanged.

On 2026-09-16 coordination approved the next E slice: ordinary-workbench wiring
with closed production capabilities and synthetic acceptance only. Route existing
Sessions by their persisted adapter ID; never fall back from Codex ACP to the old
direct controller. Reuse the existing Codex workspace and shared Host authorities.
Production ACP new Session, authentication, catalog/model mutation, tasks and
interactions remain unavailable. No real login/key/model call, app build/install,
existing schema14 migration, or old Codex deletion is authorized. If the old
workspace coupling requires a material rewrite, stop at a minimal facade/state
layer and report the remaining paths for review.

2026-09-16 E account/model admission finite slice is implemented for coordination
review in adapter 0.1.5. Scoped fresh account plus a complete bounded catalog and
explicit visible model/effort/provider selection are checked against native start.
Approved fixed-protocol handling: thread/read confirms identity/provider/idle only;
model/effort come from the original checked start/resume snapshot. Cold resume has
no model overrides and must match immutable shared Session selection metadata.
Source schema15 adds only that Session column; no account/catalog/credential or
second Provider/Turn table. Per-Turn sources reuse native_observation bindings and
are not managed verification or account/model CAS. Model-settings drift invalidates
the actual snapshot; an old choice cannot revive it. Host and Adapter recheck before
synthetic dispatch. Rust 512 passed/31 ignored, frontend 308, Pi Adapter 192,
Node 23 and E explicit 47 passed. Production admission/login/model/tasks/thread
mutation/interactions/steer and ordinary UI remain disabled. Real profile checks
are empty/read-only; installed apps/schema14 data are unchanged. Review may enable
a bounded workbench wiring slice, not real authentication/task or installed E exit.

2026-09-16 interactions coordination review passed (Host 10/10, Node typed boundary
9/9 independently rerun). Continue only synthetic account/model admission using
fixed 0.143.0 account/read/updated and a complete bounded paginated model catalog.
Explicit visible model/effort selection, original actual session model confirmation
and pre-dispatch checks must use shared Host authorities and native-observation
records, not managed verification. Production capabilities remain hard-disabled;
no real credentials/model calls, UI wiring, installation or existing DB migration.
Fixed protocol gaps must be reported, not filled with invented response fields.

2026-09-16 E synthetic interactions/steer finite slice is implemented in maintained
adapter 0.1.4 and ready for coordination review. Command/file native choices and
Plan-observed questions use the shared interaction registry with exact request,
item, native Turn, Host Turn/Session, tree and launch scope. Sent remains Responding;
native resolved ends the request, while Stop/expiry/mode change only revoke replies.
Question cancellation uses original-Turn interrupt, never an invented empty answer.
Same-Turn steer preserves expectedTurnId and does not create a new prompt. Synthetic
race/identity contracts pass; production interactions/steer/task/login/model and
ordinary UI remain hard-disabled. Fixed real checks remain empty-profile read-only.
Full Rust 504 passed/31 ignored, frontend 308, Pi Adapter 192, E explicit 39 and
Node contracts 16 passed. Next safe finite scope after review is account/model
admission before workbench wiring; no installed E exit or old-path removal follows.
Detailed limitations, fixed hashes and evidence are in the implementation record.

2026-09-16 Turn/Stop coordination review passed (26 synthetic/source tests and
7 Node contracts independently rerun). The next authorized finite slice is
synthetic command/file approval, Plan-only requestUserInput and same-Turn steer,
using fixed 0.143.0 schemas/source and shared interaction/session/Turn/event
authorities. Default questions, follow-up, real task/login/model/interaction/steer,
ordinary UI, installation and old Codex removal remain disabled. Preserve native
request IDs and choices; do not auto-answer or equate sent/ACK with native resolution.

2026-09-16 E profile/thread review passed. Continue the bounded synthetic Turn,
item-event and Stop slice through the shared TurnCoordinator, session-operation
occupancy and event router. Fixed 0.143.0 schemas own native turn/item identities;
interrupt acknowledgement never settles a Host Turn. Keep production task/login/
model entry hard-disabled, test injection no-network only, and real fixed tests
empty-profile read-only. No approvals/questions/steer/review, UI registration,
installation, old Codex removal or existing database migration in this slice.

That slice now has synthetic native Turn/text/reasoning/item/interrupt and terminal
history recovery on the shared Host path, maintained adapter 0.1.3. Native command
and file-change projections contain validated ID/type/status only; raw command,
output, paths/diffs/errors and unknown envelopes remain private and bounded.
Completed/failed/interrupted settle only the original reservation; disconnect or
timeout keeps unknown occupancy. Cross-generation unknown-Turn reconciliation is
not implemented. Normal cold metadata open plus terminal history read never resends.
Production tasks/authentication/model remain disabled; fixed real tests are empty
profile read-only and local rejection checks, not native task acceptance. The finite
slice is ready for coordination review before synthetic interactions, not installed E.

2026-09-16 E Configure review passed. The next bounded slice is authorized:
extend the shared owned-profile authority for exact Codex restore, classify private
authentication versus validated thread events, and synthetic thread list/read/start/
resume contracts. Fixed real tests remain empty isolated-profile list/read only;
production login and thread mutation stay disabled. No Turn/model/tool/interaction
work, ordinary UI registration, installation or old Codex deletion. Schema changes
are tested only in temporary databases; preserve all existing application domains.

This slice now has schema-15 shared profile launch metadata/generations and a
private lifetime lease, plus synthetic Host Session registration/cold open. The
existing sessions.native_session_id remains thread.id; the shared locator kind
codex_tree_session_id holds opaque thread.sessionId, never a PathBuf. Pi file
locators keep their original semantics and uniqueness; Codex trees may contain
multiple threads. Fresh list/read must confirm the persisted pair and cwd before
resume; rollout path is only a validated current observation, not control identity.
Adapter 0.1.2 privately retains bounded native envelopes and only projects verified
thread lifecycle metadata. Production login/start/resume remain hard-disabled;
real profile restore still refuses auth/config/history. This is not native Turn,
full event mapping, authenticated recovery, ordinary UI or installed E acceptance.
Detailed source/synthetic/fixed-real evidence and first failures are in the record.

2026-09-16 next E slice is authorized: shared Host connection lifecycle/Configure
operations and synthetic-only Codex authentication. Fixed real 0.143.0 remains
unauthenticated-read-only; do not launch real browser/device/API-key login or model
requests while the user rests. Typed temporary key/instruction payloads never enter
args, events, DB, logs or native error text. Adapter maintenance changes must repin
all module hashes. Native Session/Turn, installed replacement and old Codex removal
remain outside this slice. Preserve unknown credential outcomes and original identities.

That finite E slice now has shared AcpRuntime/HostSessionController lifecycle and
connection-level Configure occupancy, with browser/device/key/cancel/logout tested
only against an injected no-network synthetic App Server. Adapter 0.1.1 pins entry,
core and Configure modules; its production entry hard-disables authentication.
Late replies cannot authorize a new generation; canceled key commits remain unknown.
Account reads never verify models/tasks. Authentication instructions stay ephemeral;
after a synthetic authentication attempt, unsolicited native payloads are quarantined
to avoid secret echoes. This is a deliberate task-disabled limitation, not complete
native-event preservation. Resolve persistent owned-profile recovery and the private
authentication versus task-event channel before enabling native Session/Turn work.
No ordinary Tauri/workbench activation, real login, installed E exit or old Codex
deletion is established. Detailed checks and first failures remain in the record.

2026-09-16 D-to-E continuation is now authorized: remove only obsolete Pi RPC
new-session controls after reference checks, preserving existing RPC-bound Session
open/recovery and all QA/daily data. Then audit fixed Codex 0.143.0 and the current
shared-Host integration before a bounded engineering slice. No real login, browser/
device-code flow, user-auth import, model calls, packaging or app replacement in this
slice. A mandatory interface/version or structural decision remains a stop gate.
This supersedes the acceptance-only E stop below, not its evidence boundaries.

The first D-to-E engineering slice now removes Pi RPC new-session controls while
retaining bound RPC open/recovery. E has a maintained read-only ACP adapter 0.1.0
over fixed Codex 0.143.0, using the shared ACP transport/initialize service and a
fresh private home. Fixed-binary unauthenticated account/list and synthetic scoped
failure/unknown-event checks pass. Browser/API-key/device-code types and ephemeral
UI states are contracts only; login, native thread/turn work, persistent profile
recovery and ordinary Tauri/workbench activation remain unimplemented in E. Do not
remove the old Codex controller from this narrower read-only evidence or call it
a fallback for the new adapter. No installed applications/data were upgraded.

2026-09-16 latest D mandatory acceptance exit is complete under the approved evidence reuse
and pinned-Pi limitations. This supersedes the dated partial checkpoints below, not their
historical failures. On unchanged installed D QA `80fc988c`, one native bash `sleep 120`
remained active while installed UI steer and follow_up were both accepted into the same
native Session/Host Turn; three model responses completed BASE -> STEER -> FOLLOWUP with
normal tool exit and final Host settlement. Final installed cold recovery preserved the full
history without resend; all 31 protected configuration/history/QA files were byte-identical
across recovery, and quit left no sleep/D QA/ACP remnants. The earlier sleep20 attempt was
valid but its UI operation window was missed (two responses, no intervention); it was not a
product failure and was not silently retried. Each new attempt had separate explicit authority.
The earlier empty custom tool identity remains an unassigned Provider/native-decoding output
observation, not proven Farfold capability loss; do not claim its root cause is fixed.
Stop at the E entrance: no E work, production code change, rebuild, old-path deletion, formal/
Dev/P6 replacement or broad release claim was authorized in this acceptance-only follow-up.
Post-exit path removal remains unperformed and must retain its own checks. Detailed evidence
and the final 14-item matrix are in the existing implementation record.

2026-09-16 latest minimal repair supersedes the prior workflow stop below: independent
installed D QA `80fc988c` closes empty managed-session trust recovery and /session control
display in the scoped installed checks. Managed pre-file ownership is separate from native
first-use, bound to stable ownership/bootstrap and revoked before model dispatch or model/
profile/auth mutation; old references without proof remain blocked. /session uses the existing
bound workspace read, creates no Provider Turn, and displays only current-connection Adapter
control text, not native history. Formal/Dev and fixed Pi 0.84.3 remain unchanged.
The one authorized HOLD attempt produced two real GLM-4.6V responses, but the native toolCall
had empty name and ID, followed by `Tool  not found`; the hold window never opened. No steer
or follow_up was sent and no retry was made. Root cause is unconfirmed; do not claim missing
registration, native active-queue acceptance, or D completion. Five D QA Sessions and ten Turn
bindings are preserved; original/file cold restore changed none of 28 protected files, with
no resend or process remnants. Keep D partial, old Pi intact and E closed; further real retry
is not authorized by the unused part of this four-request cap. Details and the current 14-item
matrix are in the existing implementation record.

2026-09-16 latest installed-workflow checkpoint: the current signed D QA `d8a3425d`
completed a new real ordinary-Zhipu GLM-4.6V streaming Stop, one isolated managed-worktree
write with native tool/disk/Host path/diff/preview/Finder evidence, four native Extension
dialogs and timeout withdrawal without model calls, and exact original/file-session cold
recovery without resend. The external budget of four requests is exhausted. An intended
steer reached submission after the base task ended and became a new ordinary prompt;
do not claim installed active steer/follow_up or add calls. Two installed gaps remain:
changing project trust on an empty managed Pi Session cannot restore its not-yet-written
native file; /session emits an ACP-only text chunk ignored by PiWorkspace and its native
history refresh. These are not fixed-Pi manual-compaction limitations or accepted closures.
Keep D incomplete pending those boundaries and remaining active-intervention acceptance;
no production fix, old-path deletion, E work or formal/Dev replacement in this check.
The original Session is unchanged except its expected appended Stop history. Isolated root
and empty managed preparation Sessions have zero model calls and remain separate from the
managed file Session. All 23 protected configuration/history files stayed byte-identical
across the final dual-session cold restore. See the latest implementation record and plan.

2026-09-16 current checkpoint (supersedes the two earlier stop records below): the user
approved keeping pinned Pi 0.84.3 manual compaction with Stop explicitly unsupported.
The maintained adapter now shares model/idle preflight and activity exclusion for prompt and
compact; native compact end plus RPC result and exact idle identity own settlement. Missing
evidence remains unknown; compact never fabricates ordinary Provider verification. The UI
disables manual-compaction Stop and raced control requests return unsupported without native
abort; ordinary Stop remains available. Adapter/frontend/Rust regressions and one isolated
fixed-Pi localhost compact/cold-restore check passed. The signed independent
`/Applications/Farfold D QA.app` candidate `d8a3425d` passed installed original-session restore
and cold restore without resend; schema14, existing profile/credentials/history were preserved.
This follow-up made zero external model requests. Formal/Dev applications remain unchanged.
This closes the scoped compaction repair and independent install/recovery, not the full D exit:
remaining installed native-workflow acceptance is still required before deleting old Pi paths
or starting E. Historical startup timeouts remain unexplained. Full evidence is in the latest
implementation-record entry. The following dated blockers describe prior states, not new pauses.

2026-09-16 subsequent compaction repair was authorized, then encountered a new fixed-Runtime
blocker before production edits: one isolated localhost compaction on the pinned Pi 0.84.3
binary returned success to RPC abort while isCompacting remained true; the compaction later
completed successfully with aborted=false. Native RPC abort does not invoke abortCompaction.
Do not claim manual-compaction cancellation from an abort ACK or use process kill as success.
The failed model-preflight regression remains red; no production fix or D QA install occurred.
Report this native-interface limitation for a scope/version decision before continuing the
mandatory compaction Stop gate. Details and reproducer are in the latest implementation entry.

2026-09-16 current D exit checkpoint: the isolated D QA candidate has a real ordinary-Zhipu
GLM-4.6V success, an additional authorized active Stop with native aborted history, and exact
cold recovery without resend. Fixed-Pi localhost RPC/ACP comparison now covers write/tool/diff,
steer/follow_up ordering and terminal settlement. The mandatory capability audit found that the
adapter's model-using /compact branch bypasses ordinary prompt model preflight; a synthetic
regression is intentionally red. Under this turn's stop-on-new-material-gap instruction, no
production fix or independent /Applications D QA installation was performed. Close the existing
compaction model/lifecycle boundary before resuming D installation gates; do not weaken the
check or route through the old Pi path. D remains incomplete, E is not started, formal/Dev data
are protected, and the historical startup timeout remains unexplained. See the active plan and
the latest implementation-record matrix for evidence levels and the precise stop point.

Current execution status (2026-09-12): the user explicitly resumed D implementation after the
foundation-slice pause and documentation audit. The subsequent proposal to transfer to a new task
was withdrawn before any new task was created; continue in the existing task and this checkout.
The earlier pause remains historical, not the current execution instruction. Preserve existing
changes, applications, credentials and daily history and retain the approved stage-exit gates.

On 2026-09-13 the user explicitly chose the second reviewed D model/authentication option and
authorized implementation: keep the shared Host/ACP and existing Pi adapter; the official SDK
inside the adapter handles authentication/catalog assistance, while the Pi process executes the
Agent. Stable owned profile/launch identity is separated from per-turn typed managed-version or
native-observation bindings. This structural decision is approved; do not ask again. Implement
version projection/credential conflicts, atomic model-to-turn binding, secret/cancellation
boundaries, and exact original-session recovery through the shared services. Never use SDK
createAgentSession to replace Pi execution, add a Host RPC fallback, invent credentials, or weaken
model checks to claim completion. New material decisions beyond this scope still require approval.

D now captures the actual native model before Host admission and rechecks it in the adapter before
the native prompt write. Typed native receipts never create managed verification. Native-observation
turns are admitted only after original-target model selection and actual idle-model confirmation,
with scoped fixed-Pi/local-simulated-request and original native cold-restore evidence. The later
first-use slice carries the pending authentication/selection states through that same Host path and
exact native identity. Cold recovery has scoped pre-launch original model/branch checks and fixed Pi
empty-branch rejection/recovery evidence; unknown formats or models absent from the static catalog
remain blocked. Complete native capability preservation, real-Provider authentication and the installed
D exit remain incomplete. Do not describe adapter read/write exclusion as a Runtime-internal model CAS
or an account/credential guarantee.

Managed Pi profile updates now have scoped same-session write/refresh/select and cold-recovery
evidence, including one request to a local simulated model using the selected version. Configuration
changing/unknown states expose only last-confirmed source, never a current verified Provider.
This is not real-Provider request acceptance or the installed D exit; an observation alone cannot admit a task.

The subsequent D authentication slice connects ephemeral typed login/status/reply/cancel through
the existing ACP adapter and Host Configure operation. Fixed SDK synthetic native-key storage and
same-Pi refresh preserve session/model/history without model calls; mock-IPC workbench Provider authentication,
cancel and unknown recovery are scoped checks only. SDK logout now has the same scoped commit/refresh
and UI evidence. Authentication refresh re-reads the adapter's model configuration; explicit native
selection has scoped task/source-binding evidence but is not real-Provider or installed acceptance.
Real-Provider credential/request acceptance and the installed D exit remain incomplete. Never persist authentication
prompts/replies as session events or equate credential commit with a verified model request.

The native-only first-use foundation uses source schema 14: only a stable Pi ACP owned profile may
omit both managed bootstrap references, without creating managed authorization. The shared Host/ACP
entry now has scoped empty-profile login, pending-selection cold recovery, explicit native selection,
one local-simulated-model task and exact original-session recovery evidence. It remains closed to
task admission until the typed first-use state is ready and the actual idle model matches. Real-Provider
credential/request acceptance, a real database migration and installed D acceptance have not been performed.

The only active plan is `plans/runtime-neutral-lifemodel.md`. Read its current step first.
Detailed requirements live in the existing next-stage specification; execution/test evidence lives in
`reports/2026-09-10-host-architecture/Farfold-实施与验证记录.md`. Older plan and delivery records are
archived at `plans/archive/runtime-neutral-lifemodel-through-2026-09-11.md`; do not treat them as current
authorization or read the full archive on every turn. Keep new detailed logs out of the active plan.

On 2026-09-11, the user approved implementation of the current active plan, including
its tiered testing cadence, and lifted the planning-only pause that existed then. Following the
explicit 2026-09-12 resumption above, use targeted checks during changes, brief workflow smoke checks,
and complete real-Agent/Provider installed-app acceptance at stage exits before replacing old paths.
Do not run full builds, installed UI suites or paid model calls after every small edit without a
relevant reason. Required stage/delivery checks and native-capability preservation gates remain.

As of 2026-09-12, C1-C5 passed OpenCode Dev engineering exit and independent coordination review.
The installed Dev candidate and scoped evidence reuse are recorded in the existing implementation
record. New Dev OpenCode sessions use the approved independent ACP adapter; existing Server-bound
sessions retain their original open path. This is not user acceptance or a formal upgrade.
The subsequent user authorization on 2026-09-12 started D (Pi), then E (Codex). D has implemented
the maintained Pi adapter's interaction, terminal-outcome and identity contracts, plus partial
shared Host integration. Ordinary Host Pi ACP startup/profile/native Session registration and
native model application checks now have scoped evidence. Task/stop/recovery and per-turn Provider
receipts have scoped contracts, including real Pi with a local simulated HTTP model and native cold
restore. Existing ACP sessions and ordinary managed-Provider creation are wired into PiWorkspace
with scoped mock-IPC browser checks, not installed-product evidence. Full native model/authentication
preservation, workbench and installed real-Provider exit remain incomplete. E has not started. The user approved finite extensions to the pinned upstream pi-acp adapter,
including its stated maintenance responsibility. Do not ask again for that approval. Do not rewrite
the whole adapter or modify Pi itself; material structural changes beyond the approved 2026-09-13
profile and Provider-binding decision require a new decision.
Keep the usable Pi path until D exit.
Formal Farfold 0.1.7 is unchanged.

The user confirmed all requested acceptance on 2026-09-09. Version 0.1.7 is installed and packaged;
records, checks and protected daily application/data recovery are recorded in the active plan.
One post-replacement Pi startup timeout remains an unexplained observation despite subsequent
successful cold resumes; do not describe it as conclusively fixed or expand the release claims.
Cross-Agent handoff, collaboration, LifeModel System integration and a fourth Runtime are deferred
by the user; do not start their research or development. The historical implementation sequence follows.

Current direction, approved by the user on 2026-09-07: two internal deliveries. First improve
Pi/OpenCode's complete user journeys and shared Host mechanisms; then accept Codex as a third
Runtime. Investigate Codex interfaces alongside the first delivery, without making it a blocker.
The approved 2026-09-11 plan keeps the scope to OpenCode, Pi and Codex, with OpenCode first,
Pi second and Codex third; it does not add a fourth Runtime, LifeModel work, remote Host work or
cross-Agent collaboration. Public Host, ACP, installation, Provider and workbench responsibilities
must be implemented through one reusable mechanism, while Agent-native decisions and special
capabilities stay in the Adapter/runtime boundary.

1. P0: synchronize the development contract, reproduce current gaps, and compare native use with
   Farfold using fixed versions and equivalent inputs; distinguish facts, inference and unknowns.
2. P1–P3: improve starting work, intervention and return/resume; share typed Host authorities and
   workspace containers, preserve native differences, and delete replaced control paths per slice.
3. P4: verify Codex CLI 0.143.0 official App Server interfaces and distribution. The user approved
   experimental API opt-in on 2026-09-08 for verifying native questions in Plan mode; keep the
   Default-mode under-development question feature disabled. On 2026-09-09 the user accepted
   first-release cold history limited to content restored by the official 0.143.0 APIs; expose
   missing command details truthfully. All other scope/version gates remain.
   Reuse a
   user-installed macOS arm64 binary or official npm entry; never install/upgrade the user's CLI.
4. P5–P6: connect an owned stdio App Server in independent development/QA/daily Codex environments;
   support core work, native approvals, questions, steering and resume, then run three-Runtime
   installed-app acceptance. No automatic import of default Codex authentication or history.

Historical P0–P6 schema allocation: schema 7 belonged to the first delivery and schema 8 added
verified system-installation launch references in the second. Current source adds schema 13 for
exact stable-profile Provider-version authorization; this slice is under development, not a real
database upgrade. Schema 9/10/11/12 and the in-progress 13 evidence are in the implementation record. These historical
allocations do not instruct a downgrade. Source schema 14 now makes Pi bootstrap optional as an
in-progress first-use foundation only; schema 13 remains the exact-version authorization layer.
Keep the two-active-turn and Working Copy exclusivity limits. Codex's
first slice does not contribute to or consume LifeModel; freeze the existing prototype and leave
LifeModel System research to its independent team. Cross-Agent handoff/collaboration remain future
research. A mandatory Codex interface failure outside that approved exception blocks P5, not the
first delivery. Experimental opt-in itself is not evidence that native questions work.

For key designs, consult relevant mature industry practice and the fixed Runtime's official
contract; record the source, adopted behavior and reasons for deviations in the active plan.
At baseline, interface selection, each slice and delivery, independently recheck claims against
actual source, native responses, installed binary identity and task results. Do not turn assumptions,
static capability flags, historical QA, or command acceptance into current product availability.

Public update hosting, Developer ID, notarization, and public distribution are not blockers for
this internal milestone. An unconfigured updater must be truthfully unavailable. LifeModel keeps
its main-interface entry and defaults to disabled; freeze its feature development until base
functionality is dependable. Preserve existing opt-in and governance semantics.
Manual upgrades must verify paired application/data backup and recovery.
Replaced control paths and unused implementations must be completely deleted in the same verified
slice; do not retain parallel control authorities or fallback implementations.

The earlier one-time development-history reset is complete. New daily data is user data. Cleanup
now covers only identified unused Farfold QA artifacts. Verify exact ownership and preserve
credentials/configuration before deletion; never infer that external
Projects, worktrees, shared Runtime configuration, or another Agent's research are disposable.
Do not keep obsolete compatibility paths or unlimited backups solely to preserve test history.

`research/2026-09-02/p0-baseline-ownership-and-data-map.md` records the completed P0 baseline.
`plans/gate-0.md`, D1–D4 reports, and
`research/2026-09-06/runtime-host-productization-history.md` are historical evidence, not active
implementation plans. Previously recorded paths may refer to artifacts already removed.
