# Gate 0 — Pi-native personal Agent

This is the only active development plan.

## F0 — Clean foundation

- Independent repository, remote, app identity, and data directory
- Tauri 2 + React macOS application
- Pinned and checksum-verified Pi sidecar
- Minimal typed runtime boundary

## F1 — Runtime lifecycle

- Start Pi in RPC mode for the selected Project
- Parse JSONL without corrupting Unicode or merging records
- Send commands, surface events and diagnostics, stop the process, and recover from termination

## F2 — Native conversation

- Pi-native Provider, model, authentication, Session, and streaming behavior
- New Session and resume existing Session
- User/Agent messages and tool activity rendered from Pi events

## F3 — Real work

- Project folder maps to Pi cwd
- Pi-native project trust and resource discovery
- Coding task modifies and verifies files
- Non-coding task reads multiple documents and produces Markdown

## F4 — Control and continuity

- Abort in-flight work
- Steering and follow-up use Pi semantics
- App restart resumes the same Pi Session
- Errors remain explicit and recoverable

## F5 — Exact native acceptance

All ten scenarios must pass in the installed macOS app:

1. First launch reaches a real Provider and model.
2. A new Session completes a knowledge question.
3. A real Project folder is selected and Pi project trust is honored.
4. Pi reads Project resources, including applicable AGENTS and Skills.
5. A coding task modifies files and verifies the result.
6. A non-coding task reads multiple documents and creates a Markdown result.
7. Stop prevents continued execution.
8. Steering changes the in-flight direction through Pi semantics.
9. Restart resumes the same Pi Session.
10. All evidence comes from the formal Tauri application, not a browser or standalone CLI.

## Completion Rule

Stages advance only on working product evidence. Agent coding time is recorded as diagnostic
information, not used as a deadline or as a substitute for scope and acceptance.

## Current Checkpoint — 2026-08-29

- F1 host stabilization is implemented: serialized lifecycle states, generation-scoped events,
  intentional-stop semantics, child reaping, and recoverable atomic Session pointers.
- F2 host projection is implemented but awaits successful Provider acceptance: Gate 0 RPC commands
  are typed, Extension UI requests are handled, and resumed messages/tool results retain Pi order.
- The installed application starts, stops, restarts, and resumes the same Pi Session. DeepSeek auth
  is present, but its real conversation remains blocked by `402 Insufficient Balance`.
- Farfold now has a bounded in-app API-key flow for common built-in Providers. It writes only to
  Pi's native `~/.pi/agent/auth.json`, preserves other/OAuth entries, uses atomic `0600` writes,
  never returns stored secrets, and restarts the same Project/Session after a credential change.
- RPC requests now complete only after a correlated Pi `response`; pending requests fail on timeout,
  termination, or runtime-generation changes. A successful stdin write is no longer treated as Pi
  acceptance.
- The native UI separates Pi process state from Provider request state, discovers Pi commands for
  slash completion, renders safe Markdown/thinking/tool detail, and allows idle Project switching.
- F3 through F5 remain open until a funded Provider completes the formal native scenarios above.
