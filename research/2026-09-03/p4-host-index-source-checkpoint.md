# P4 Host index source checkpoint

Date: 2026-09-03  
Scope: source authority only; no legacy migration, installed acceptance, or formal promotion

## Accepted source commits

- `b276d84`: global SessionBindingIndex and WorkingCopyManager read snapshots;
- `d00d1c0`: bounded, foreign-key-scoped, transactionally durable per-Session drafts;
- `9580b35`: atomic manual title, pin, and archive metadata updates;
- `fe71717`: version-and-digest-verified managed Runtime registration during discovery.
- `0827039`: read-only root checkout / linked worktree identity resolution.
- `70bd0a5`: official-validation cutover for new OpenCode bindings.

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

## Evidence

The required source gates passed at `70bd0a5` and its preceding P4 commits:

- frontend format and typecheck;
- 16 frontend files / 84 tests;
- frontend production build;
- Rust format;
- Rust Clippy with warnings denied;
- 108 Rust tests.

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

## Explicitly open

- Copy-verify legacy Pi/OpenCode bindings only after official Runtime identity/history validation;
  do not background-scan Runtime stores.
- Cut new Pi Session bindings to the Host store through Pi's correlated official state/history
  surfaces before retiring `last-pi-session.json` writes.
- Add durable attention/review, import/export, delete preview/confirmation, relocation, and Git
  dirty-state safety.
- Run exact same-build installed acceptance before any formal application replacement or shipped
  OpenCode claim.
