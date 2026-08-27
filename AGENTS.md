# Farfold AI Coding Entrypoint

This repository is the only writable checkout for Farfold.

## Read Order

1. `AGENTS.md`
2. `PRODUCT.md`
3. `plans/gate-0.md`
4. Task-relevant source and upstream Pi documentation

## Product Boundary

- Farfold is an independent product, not OpenLife Next and not an OpenLife migration.
- Do not import, copy, or depend on OpenLife source, schemas, state machines, data, or UI.
- Upstream Pi is the single Agent runtime. Do not implement a second Agent loop.
- The desktop host sends commands and renders Pi events; it does not reinterpret Agent intent.
- Keep Pi-native Provider, model, Session, Project, resource, Skill, Extension, tool, compaction,
  steering, abort, and resume behavior unless a verified product requirement says otherwise.
- Gate 0 contains no LifeModel, Proposal, custom permission framework, Task/Run/Item model, or
  Review workflow.
- A future LifeModel Proposal will only govern whether content enters LifeModel. It will not be
  an Agent tool permission mechanism.

## Development Rules

- macOS is the only Gate 0 platform.
- Pin the Pi sidecar to the version and SHA-256 recorded in the fetch script.
- Use the installed Tauri application as delivery truth. Browser-only and CLI-only evidence do
  not complete Gate 0.
- Keep one active Markdown plan. Do not build machine-readable governance or evidence systems.
- Prefer typed runtime boundaries and product behavior tests.
- Never log or commit provider credentials.

## Checks

```sh
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```
