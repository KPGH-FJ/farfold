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
