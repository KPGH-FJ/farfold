# D4 cross-Runtime LifeModel installed-app acceptance

Date: 2026-09-01
Status: completed by the 2026-09-02 strict-governance follow-up
Scope: Pi and OpenCode contribution to, and consumption of, one Farfold-owned canonical LifeModel

## Delivery truth

The accepted core matrix ran in the separately installed macOS QA application:

- application: `/Applications/Farfold D3 QA.app`;
- bundle identifier: `ai.farfold.desktop.d3qa`;
- data directory: `~/Library/Application Support/ai.farfold.desktop.d3qa`;
- project: `/private/tmp/farfold-d3-native.MYHuXa`;
- full native matrix executable SHA-256:
  `2f6a2cfe85d7c8777291c39a2554d5f61b067810331fb3e0d6010a90a4fe1f30`;
- final promoted and focus-fixed executable SHA-256:
  `e24a718f45ecc69c3e391ecdd3980675cb8f43e46db48665f6b50ddde80ac975`.

The final release-bundle and installed executables have the same SHA-256 and
`codesign --verify --deep --strict` passes. The formal `/Applications/Farfold.app` executable
remained unchanged during both QA replacements; its observed SHA-256 was
`cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23` before and after each
replacement.

The real Provider credential was supplied only to the QA process environment. It was not written
to Farfold source, fixtures, documentation, or the LifeModel store.

## Official Runtime boundaries

OpenCode was not patched or forked.

- **C1 contribution:** Farfold rereads the bound native Session through OpenCode's official
  Session messages API after `session.idle`, accepts only durable user messages from that exact
  `ses_` Session, and retains the native `msg_` identifier.
- **U1 consumption:** Farfold sends selected canonical context through the official per-turn
  `system` field of `prompt_async`. The context is bounded to the current turn and is not written
  into OpenCode Runtime memory.
- **Pi contribution:** the existing official `get_entries` boundary remains unchanged.
- **Pi consumption:** the existing one-shot `before_agent_start` Extension channel remains
  unchanged.

Base operation, contribution, and consumption remain separate capability fields. A LifeModel
preparation failure is fail-open for Base conversation and does not create a successful manifest.

## Full native matrix

The matrix began with an empty QA LifeModel store.

### OpenCode contribution and use

- Created native Session `ses_fa30eeaf4ffeuxucv1EjrCDdRC` through OpenCode 1.15.13.
- Sent an explicit preference statement and received `D4_OC_SOURCE_OK`.
- Official history produced source entry `msg_05cf20f51001sxksJbnGMq0yVG`; the UI labelled it
  `OpenCode` and showed its native Session and entry provenance.
- Created Proposal `proposal-1788265819111-0`, normalized it to
  `answer_style = 先给结论，再给必要细节`, and explicitly approved it before canonical write.
- Selected the materialized item through the next-message preview. OpenCode answered
  `先给结论，再给必要细节` and the manifest moved to `sent`.

### OpenCode-origin item consumed by Pi

- Resumed Pi native Session `01a05653-40e6-7c1d-bd5f-9e8f3772f6f9` without changing its Runtime,
  Provider, or native history.
- Selected the same OpenCode-origin canonical item in the Pi composer preview.
- Pi answered `先给结论，再给必要细节。`; its independent one-shot manifest moved to `sent`.

### Pi contribution and reverse OpenCode consumption

- Sent an explicit Pi preference statement and received `D4_PI_SOURCE_OK`.
- Official Pi history produced native entry `9601d0ff`.
- A second explicitly approved Proposal with the same category, key, and value retained the Pi
  source alongside the OpenCode source instead of replacing provenance.
- The canonical item then showed `2 个来源` and remained Runtime-neutral.
- OpenCode selected the merged item in its own next-message preview and again answered
  `先给结论，再给必要细节`.

The final persisted canonical record is:

- item: `item-1788265835466-3`;
- key/value: `answer_style = 先给结论，再给必要细节`;
- OpenCode source: installation `bundled-opencode-1.15.13-arm64`, Adapter
  `opencode-server-http-sse-v1`, Session `ses_fa30eeaf4ffeuxucv1EjrCDdRC`, entry
  `msg_05cf20f51001sxksJbnGMq0yVG`;
- Pi source: installation `bundled-pi`, Adapter `pi-rpc-jsonl`, Session
  `01a05653-40e6-7c1d-bd5f-9e8f3772f6f9`, entry `9601d0ff`.

The persisted manifests are independently auditable:

1. `injection-1788265886073-5` — OpenCode —
   `opencode_prompt_async_system_per_turn` — `sent`;
2. `injection-1788266039560-8` — Pi —
   `pi_extension_before_agent_start_system_prompt_once` — `sent`;
3. `injection-1788266229868-15` — OpenCode —
   `opencode_prompt_async_system_per_turn` — `sent`.

## Final-hash targeted regression

The final executable hash received a targeted installed regression after capability promotion and
the modal keyboard fix:

- all old QA processes were stopped before relaunch, avoiding stale-window evidence;
- OpenCode visibly reports `Base=yes Contributes=yes Uses=yes`;
- the one canonical item, both independent sources, and all three `sent` manifests survived app
  replacement and process restart;
- disabling LifeModel disabled next-message item selection, and the backend test proves disabled
  state cannot prepare or record an injection;
- LifeModel was restored to enabled state;
- focus remains inside the modal when Tab or Shift-Tab reaches an edge, and Escape closes the modal.
- final app exit left no Farfold QA, Pi capability, Pi Runtime, or OpenCode Server process running.

This final regression did not repeat the real-Provider messages. Those remain evidence from the
full pre-promotion matrix hash; the post-matrix changes were capability declarations and modal
keyboard behavior.

## Repository verification

The final source passed:

```text
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test                13 files, 66 tests
corepack pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked   44 tests
```

Vite emitted its existing chunk-size advisory; it did not fail the build.

## Strict D4 closure audit

- Passed: canonical items carry no Runtime owner.
- Passed: Pi and OpenCode sources require separate Proposals and explicit approval, and retain
  independent provenance.
- Passed: both Runtimes preview and audit next-turn consumption through Runtime-specific manifests.
- Passed: OpenCode C1 and U1 are independently verified and may report `yes`.
- Passed on 2026-09-02 in installed QA executable
  `3cb42db260b0f4ee77e5c027e16d4bc6490ac3de67a044bb3d8179283550f2d4`: selecting the canonical
  item exposed the composer chip, removing it before send removed the chip, and the persisted
  manifest count remained `3 -> 3`.
- Passed on 2026-09-02: OpenCode native Session `ses_f9f72556bffehPc7nmuCt9GWEs`
  contributed durable message `msg_0608e792100170OcRE9Dd4pZhc`. Proposal
  `proposal-1788326421583-0` displayed the existing and conflicting values, warned that no overwrite
  would occur without approval, and was explicitly rejected. The canonical value remained
  unchanged.
- Implemented in source and focused tests: withdrawal preserves the immutable Source Envelope in
  Proposal audit history, records a separate withdrawal event, removes only the canonical support
  link, retains a canonical item with another approved source for the same current value, rejects
  withdrawal of the last supporting source, and prevents the same native source from being
  reintroduced for the same key.
- Passed on 2026-09-02 in the same installed QA executable: the user explicitly withdrew the
  OpenCode source from the two-source `answer_style` item. Active sources changed `2 -> 1`, the Pi
  source and canonical item remained, withdrawal audit changed `0 -> 1`, and manifests remained
  `3 -> 3`. The remaining item could still be selected for next-turn use; the last-source withdraw
  control was disabled with an instruction to explicitly delete the canonical item instead.
- Passed after application restart: the one-source canonical item and OpenCode withdrawal audit
  remained visible with exact native Session and entry provenance.
- Passed on 2026-09-02: a second durable OpenCode message
  `msg_06090a01d001pVvNDKYlhasU55` was separately approved through Proposal
  `proposal-1788326541440-4`, restoring the canonical item to independent Pi and OpenCode sources.
- Passed on 2026-09-02: the user explicitly deleted two-source canonical item
  `item-1788265835466-3`. The installed Pi and OpenCode workspaces both lost the selectable item and
  composer preview; persisted item count became zero; all three historical manifest previews were
  redacted while their metadata remained; and both Runtime prepare paths reject the deleted item.
- Passed after application restart: the canonical list remained empty, all approved Proposals were
  visibly non-materialized, and the withdrawal audit remained available.

The D4 capability and governance matrices are accepted. This closes D4 without changing either
Runtime. Promotion into the formal `/Applications/Farfold.app` remains a separate product-release
decision and is not implied by this QA acceptance.

## 2026-09-02 governance implementation checkpoint

- Installed QA executable: `3cb42db260b0f4ee77e5c027e16d4bc6490ac3de67a044bb3d8179283550f2d4`;
  `codesign --verify --deep --strict` passed.
- The formal `/Applications/Farfold.app` executable remained
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- Frontend checks passed: Prettier, TypeScript, 13 files / 66 tests, and production build.
- Rust checks passed: fmt, Clippy with warnings denied, and 49 tests.
- Focused LifeModel tests cover two-source withdrawal, last-support refusal, explicit conflict
  approval/rejection, source-reuse refusal, and backward-compatible reading of the existing
  version-1 store.
- The previous installed QA bundle is recoverable at
  `/private/tmp/farfold-d4-governance.q6sMmK/Farfold D3 QA.previous.app`.
