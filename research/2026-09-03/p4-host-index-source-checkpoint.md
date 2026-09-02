# P4 Host index source checkpoint

Date: 2026-09-03  
Scope: source authority only; no legacy migration, installed acceptance, or formal promotion

## Accepted source commits

- `b276d84`: global SessionBindingIndex and WorkingCopyManager read snapshots;
- `d00d1c0`: bounded, foreign-key-scoped, transactionally durable per-Session drafts;
- `9580b35`: atomic manual title, pin, and archive metadata updates;
- `fe71717`: version-and-digest-verified managed Runtime registration during discovery.

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

## Evidence

The required source gates passed at `fe71717` and its preceding P4 commits:

- frontend format and typecheck;
- 16 frontend files / 84 tests;
- frontend production build;
- Rust format;
- Rust Clippy with warnings denied;
- 105 Rust tests.

The existing Vite chunk-size warning remains unchanged.

## Explicitly open

- Resolve root checkout versus linked worktree and stable Project identity before creating real
  Session registrations.
- Copy-verify legacy Pi/OpenCode bindings only after official Runtime identity/history validation;
  do not background-scan Runtime stores.
- Add durable attention/review, import/export, delete preview/confirmation, relocation, and Git
  dirty-state safety.
- Run exact same-build installed acceptance before any formal application replacement or shipped
  OpenCode claim.
