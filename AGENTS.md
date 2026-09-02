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
- Farfold owns one complete desktop UI/UX in which users choose among supported external Agent
  Runtimes. It does not embed or imitate a Runtime's own UI.
- Each Runtime owns its Agent loop, native Session, Provider/model integration, tools, permissions,
  compaction, steering, abort, resume, Skills, Extensions, and Runtime-specific behavior. Do not
  implement a second Agent loop in Farfold and do not fork or patch a backend Runtime.
- Farfold connects through official SDK, CLI, RPC, ACP, Server, Plugin, Extension, or Hook surfaces.
  The host starts or connects, sends commands, renders events, persists Farfold-owned references,
  and exposes truthful capability differences without reinterpreting Agent intent.
- Pi is the incumbent reference Runtime and must retain native parity. OpenCode is the first
  approved non-Pi Adapter target. Until installed-app acceptance passes, current product claims
  must still say the shipped implementation is Pi-only.
- A Session binds to one Runtime installation/connection and one native Session when created.
  Switching Runtime creates or opens another Session; it does not transplant opaque Runtime state.
- Base Runtime operation, contribution to LifeModel, and use of LifeModel are independent
  capabilities. Never infer one from another or collapse them into one support boolean.
- LifeModel belongs to the user and Farfold, not to any Runtime. Runtime-native memory remains
  separate. Content may enter canonical LifeModel only through source evidence, an atomic Proposal,
  and explicit user approval; Proposal is never an Agent tool-permission mechanism.

## Development Rules

- macOS is the only current platform.
- Pin the Pi sidecar to the version and SHA-256 recorded in the fetch script.
- Pin every non-Pi Adapter to a verified Runtime version/distribution and keep Runtime, installation,
  connection, native Session, source provenance, and context injection identities separate. A lone
  `runtime_id` is not a sufficient architecture.
- Preserve Runtime-native events and unknown envelopes at the Adapter boundary. Shared UI may
  normalize presentation, but capability-specific behavior stays inside the Adapter.
- Use the installed Tauri application as delivery truth. Browser-only and CLI-only evidence do
  not prove product availability for any Runtime or LifeModel flow.
- Keep one active Markdown plan. Do not build machine-readable governance or evidence systems.
- Prefer typed runtime boundaries and product behavior tests.
- Never log or commit provider credentials.

## Active Sequence

The only active plan is `plans/runtime-neutral-lifemodel.md`:

1. freeze and audit the committed Pi/OpenCode/LifeModel baseline;
2. build one typed, transactional Host authority before replacing frontend Runtime ownership;
3. move the existing UI onto the new Host, then deliver the conversation-first UI;
4. add bounded concurrency and Working Copy safety;
5. close LifeModel governance, update, recovery, and security;
6. promote only after exact same-build formal installed-app acceptance, then retire prototype paths.

`research/2026-09-02/p0-baseline-ownership-and-data-map.md` records the completed P0 baseline.
`plans/gate-0.md` and D1–D4 reports are completed historical evidence, not active implementation
plans.

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
