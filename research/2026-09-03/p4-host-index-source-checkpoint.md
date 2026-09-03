# P4 Host index source checkpoint

Date: 2026-09-03  
Scope: Host authority, verified legacy activation, and isolated installed QA; no formal promotion

## Accepted source commits

- `b276d84`: global SessionBindingIndex and WorkingCopyManager read snapshots;
- `d00d1c0`: bounded, foreign-key-scoped, transactionally durable per-Session drafts;
- `9580b35`: atomic manual title, pin, and archive metadata updates;
- `fe71717`: version-and-digest-verified managed Runtime registration during discovery.
- `0827039`: read-only root checkout / linked worktree identity resolution.
- `70bd0a5`: official-validation cutover for new OpenCode bindings.
- `7064689`: atomic Host cutover and native locator for new Pi bindings and resume.
- `c8d23f3`: resumable, content-addressed activation of verified legacy binding sources.
- `bee3624`: bounded durable Session attention for exact OpenCode interaction bindings.
- `d5082d0`: atomic global last Project/Session restore state on verified Session open.
- `c657933`: retain the OpenCode loopback port reservation until child launch handoff.
- `ea8b241`: bounded read-only Working Copy Git status summaries.
- `b6eb431`: atomic unarchived fallback for Session restore state during archive.
- `1bfd0fa`: bounded, read-only, fail-closed Session deletion impact preview.
- `54cb32c`: self-describing, atomic portable Host metadata export and import preview.

## Authority now present

The SessionBindingIndex reads Pi and OpenCode records from one SQLite transaction and preserves the
full immutable binding tuple: Runtime product, installation, build, Adapter, connection, Project,
Working Copy, Farfold Session, and native Session. Ordering is deterministic: pinned first, then
last-opened and updated time, then Farfold Session ID.

WorkingCopyManager reports whether the stored canonical path is ready, missing, not a directory,
identity-mismatched, or unavailable. It reports bound and unarchived Session reference counts. It
does not yet claim Git dirty state, safe deletion, active-Turn occupancy, or worktree health.

Draft writes are limited to 256 KiB, require an existing Farfold Session, use Host timestamps, and
return only after the immediate SQLite transaction commits. Clear is explicit and idempotent.
Session metadata changes are one atomic transaction; archiving retains the Working Copy and native
Session binding.

Pi and OpenCode discovery now verifies the actual managed artifact version and SHA-256 before
idempotently registering the Runtime product, installation, build, Adapter, and native-config
connection. Reusing a build identity with changed observed metadata is rejected.

Working Copy registration preview uses Git's official identity surfaces. A root checkout and its
linked worktree map to one stable Project ID and separate Working Copy IDs. Detached HEAD remains a
valid Working Copy with no branch name. Existing Git markers fail closed when Git identity cannot
be inspected; a non-Git directory is reported as non-Git instead of receiving fabricated Git
status. The preview performs no checkout or worktree mutation.

New OpenCode binding writes no longer accept Project, title, or timestamp authority from React.
React sends only a native Session ID; the Host re-reads that exact Session from the authenticated
OpenCode connection's official Session list, verifies the active Project, resolves Working Copy
identity, and commits the immutable binding tuple to SQLite. The legacy JSON store remains a
read-only compatibility source and Host records win during merged listing, so no dual write exists.

New Pi binding writes re-query Pi's official, generation-correlated `get_state` response instead of
accepting identity from React. The Host verifies the native Session ID against the constrained
native JSONL header, active Project, managed Session root, and sanitized native title. A
Pi-specific locator is committed in the same immediate transaction as the immutable Session,
Project, and Working Copy binding. Adapter identity remains authoritative in the Session row and is
not duplicated in the locator table. Host-correlated RPC responses are consumed at the Host
boundary, so internal verification cannot recursively trigger frontend `rememberSession` calls.
Resume reads Host SQLite first; the legacy Pi pointer is read-only fallback and has no remaining
writer.

Legacy binding activation uses exact source path and SHA-256 as the ledger identity. A source is
marked imported only when every structurally valid legacy record already has a matching immutable
Host binding created through the official Pi or OpenCode validation path. Missing Host evidence
leaves the source unimported; retries are safe, and a completed retry does not rewrite
`imported_at`. Source JSON remains read-only pending retirement acceptance.

Session attention now stores only bounded Host metadata: Farfold Session ID, typed kind/status,
Runtime generation, native interaction ID, and timestamps. OpenCode permission events resolve the
exact immutable native Session binding before opening attention. Successful response closes the
record; generation change or Runtime termination marks it stale. Closed/stale records are terminal,
including against duplicate native event replay. Runtime-native permission content is not copied to
SQLite. Pi Extension dialogs remain transient until the session-aware Host controller can provide a
verifiable Farfold/native Session association.

Every officially validated managed Session open now updates immutable Session registration, the
optional Pi native locator, monotonic `last_opened_at`, and the singleton global last
Project/Session pointer in one immediate transaction. A locator conflict therefore cannot leave a
new Session or a dangling restore pointer. The restore snapshot is exposed read-only from the Host;
the current React lifecycle does not consume it before the P5 authority cutover.

Working Copy snapshots now close their SQLite read transaction before observing the filesystem and
Git. For a ready path, the Host runs Git's porcelain status with optional locks disabled and emits
only clean/dirty/conflicted/not-Git/unavailable plus bounded category counts; it does not persist or
return changed paths or diff content. This is Project/Working Copy safety evidence, not per-Turn
change provenance. OpenCode launch also keeps the OS-selected loopback port bound through all
launch preparation and releases it only immediately before spawning the child, replacing the
previous release-and-rebind test race with a reservation assertion.

Archiving the Session currently named by `app_state` now updates the archive metadata and restore
pointer in one immediate transaction. The fallback is the most recently opened remaining
unarchived Session and its Project; with no candidate, only the Session pointer is cleared so the
last Project context remains available. The restore reader independently filters archived targets,
covering profiles written before this invariant was added. No native Session or Working Copy is
removed.

Session deletion now has a read-only impact contract. One consistent SQLite read identifies the
Farfold Session metadata, draft byte count, attention counts, native locator, and shared Working
Copy references; after the transaction closes, current path/Git safety is observed. The preview
explicitly retains the Runtime-native Session, Project, and Working Copy. It blocks unarchived
Sessions and open attention, and always carries `active_turn_verification_required` with execution
disabled. A future destructive command must consume a Session-aware mutation lease and a fresh
double-confirmation token; Runtime-level idle state is insufficient.

Portable Host metadata export uses SQLite's online backup API to produce one consistent database
snapshot with an embedded format manifest. The manifest records schema/format versions, export
time, content counts, and precise inclusion policy. The export includes Farfold Session titles,
Project/native-locator/legacy-source paths, and draft bodies; it excludes Provider credentials,
native Runtime history, diagnostics, and the separate pre-P8 LifeModel store. A `0600` staging file
is checked for SQLite and foreign-key integrity, synced, hashed, and activated with a same-directory
hard link that cannot overwrite an existing destination. Import preview accepts only a regular
non-symlink Farfold export and rechecks application identity, schema, manifest counts/policy,
integrity, and foreign keys. Profile replacement remains disabled pending exclusive stopped-state
activation and rollback.

## Evidence

The required source gates passed at `54cb32c` and its preceding P4 commits:

- frontend format and typecheck;
- 16 frontend files / 84 tests;
- frontend production build;
- Rust format;
- Rust Clippy with warnings denied;
- 125 Rust tests.

The existing Vite chunk-size warning remains unchanged.

## Installed OpenCode new-binding acceptance

Clean source commit: `70bd0a5d3c2ab7e3ba4ac2ef2c4ab6feee0995ce`

- Built, signed, installed, and launched `/Applications/Farfold P3 QA.app`; strict codesign
  verification passed. Main executable SHA-256:
  `c58f40f2b715bdc0b721334fdff9aa9d24e5b4c9eb6f12aad15c017a772d2e37`.
- The installed app switched to OpenCode and opened exact official native Session
  `ses_f9c6fefa9ffeARsf3raAANPTXq`. OpenCode 1.15.13 started, the UI rendered the fixed binding,
  and the Host Channel reached sequence `2`.
- `farfold-host.sqlite3` passed `PRAGMA quick_check` and contains one Session with the pinned
  OpenCode product, installation, full build ID and digest, Adapter, connection, stable Project,
  Working Copy, Farfold Session, and native Session identities.
- The legacy `opencode-session-bindings.json` remained at SHA-256
  `d5d656cbcf98a38f2f93c08c116970c3951ae76b21554f23f2ee472d1c46df77` and modification time
  `2026-09-03T07:24:47+0800`, earlier than this acceptance run. The new Host path did not write it.
- No prompt, task, permission response, or Provider request was sent.
- Formal `/Applications/Farfold.app` remained unchanged at main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- The previous QA bundle is recoverable from
  `/tmp/Farfold P3 QA.pre-70bd0a5-20260903-0755.app`.

## Installed Pi new-binding and Host-resume acceptance

Clean source commit: `7064689`

- Built, signed, installed, and launched `/Applications/Farfold P3 QA.app`; strict codesign
  verification passed. Main executable SHA-256:
  `5e6365794e897bc6b707b0187bce28d246a78accb9bfb0b937ab783146859993`.
- The installed UI started bundled Pi 0.84.3 and reopened exact native Session
  `01a063d1-6dfa-7015-b2eb-9411ad53850a`. Its existing user and assistant messages rendered and the
  Host Channel reached sequence `20` without sending a new prompt.
- SQLite migrated from schema v2 to v3 after creating
  `farfold-host.sqlite3.backup-v2-to-v3-1788394306620-0`, passed `PRAGMA quick_check`, and contains
  exactly two global Session rows (Pi and OpenCode) and one `pi_session_file` locator.
- The legacy `last-pi-session.json` remained unchanged at SHA-256
  `683de8368af4eead55619286d6e80281badb5dc5f3cf4bbbfde65af8b80fe1bf` and modification time
  `2026-09-03T07:14:57+0800`. It was temporarily moved out of the profile, the app was fully
  restarted, and the same Pi native Session and history reopened from Host SQLite. The legacy file
  was then restored with the same bytes and original modification time.
- No prompt, task, permission response, or Provider request was sent. No duplicate Session or
  locator was created during restart.
- Formal `/Applications/Farfold.app` remained unchanged at main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- The previous QA bundle is recoverable from
  `/tmp/Farfold P3 QA.pre-7064689-20260903.app`.

## Installed verified legacy activation acceptance

Clean source commit: `c8d23f3`

- Built, signed, installed, and launched `/Applications/Farfold P3 QA.app`; strict codesign
  verification passed. Main executable SHA-256:
  `9f788c747301eab71f21d09987cf70db6624dab8034531707475043374e4a9e6`.
- Before opening the existing native Sessions, `legacy_migration_sources` contained zero rows.
  Opening Pi Session `01a063d1-6dfa-7015-b2eb-9411ad53850a` and OpenCode Session
  `ses_f9c6fefa9ffeARsf3raAANPTXq` through the installed UI created exactly two `imported` ledger
  rows, each with record count one and its source content hash.
- Reopening the OpenCode Session preserved both original `imported_at` values, the two ledger rows,
  the two global Session rows, and the single Pi locator. `PRAGMA quick_check` returned `ok`.
- `last-pi-session.json` remained at SHA-256
  `683de8368af4eead55619286d6e80281badb5dc5f3cf4bbbfde65af8b80fe1bf` and
  `opencode-session-bindings.json` remained at SHA-256
  `d5d656cbcf98a38f2f93c08c116970c3951ae76b21554f23f2ee472d1c46df77`.
- No prompt, task, permission response, or Provider request was sent.
- Formal `/Applications/Farfold.app` remained unchanged at main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- The previous QA bundle is recoverable from
  `/tmp/Farfold P3 QA.pre-c8d23f3-20260903.app`.

## Explicitly open

- Retire legacy Pi/OpenCode source files only after rollback acceptance; do not background-scan
  Runtime stores.
- Add durable review, exclusive import activation/rollback, Session-aware delete execution/double
  confirmation, and relocation; use the new Git status truth in destructive-operation preflight
  rather than reinterpreting it in React.
- Move the current frontend restore flow onto the Host restore snapshot only during P5; the P4 API
  is source authority, not installed UI acceptance.
- Complete Pi attention persistence only after the Host controller supplies exact active-Session
  identity; do not infer it from a latest-Session heuristic.
- Run exact same-build installed acceptance before any formal application replacement or shipped
  OpenCode claim.
