# Farfold

Farfold is a macOS personal desktop agent with one Farfold UI for Pi, OpenCode, and Codex.

The product is intentionally independent from OpenLife. It does not import OpenLife code,
data, runtime state, or architecture.

## Internal use

The formal internal installation is version 0.1.7. Its three-Runtime core scope was accepted
on 2026-09-09 on Apple M4 / macOS 15.6. This does not mean all three use ACP.
See [团队安装与使用说明](INTERNAL-USE.md) for installation, each Runtime's authentication,
daily operation, known limits, and paired application/data recovery. Independent team-machine
acceptance remains required. This is not a public release.

## Development

> 2026-09-17 注：用户已批准 active plan 第 0 章的 5 阶段 ACP 统一路线（OpenCode → Host 契约 → 统一 Workspace → Codex → Pi）。开发仍处于暂停状态，但恢复后的执行入口以 active plan 第 0 章为准，不再沿着 9 月 16 日前的旧切片继续。文档校正不触发自动实施。

Current status (2026-09-12): implementation and automatic continuation are **paused at the
user's request**. Do not resume without a new explicit instruction. Documentation correction
is authorized separately and does not resume implementation.

OpenCode C1–C5 passed Dev engineering exit through the independent ACP adapter. Pi's maintained
ACP adapter and parts of the shared Host are implemented and have scoped verification, but the
ordinary Pi ACP profile, Provider, Session registration and workbench are not connected yet.
Pi's usable RPC path remains; Codex's existing App Server path remains, and E-stage ACP migration
has not started. Neither the formal app nor the Dev app has been replaced by the D-stage changes.
Use the [active plan](plans/runtime-neutral-lifemodel.md) for progress and the linked implementation
record for evidence; source and contract tests do not establish installed product availability.

```sh
corepack pnpm install
corepack pnpm prepare:runtimes
corepack pnpm tauri dev
```

The Pi sidecar is pinned and checksum-verified by `scripts/fetch-pi-sidecar.sh`.

The default Tauri configuration starts **Farfold Dev** with bundle identifier
`ai.farfold.desktop.dev` and its own Application Support directory. It must not write into the
daily-use `ai.farfold.desktop` profile. Debug and development-server builds reject an override to that identity before
initializing the application. Pi's native global authentication remains shared; do not reset it
when cleaning development data.

The formal OpenCode baseline and existing Server-bound sessions retain their Server path.
New C-stage Dev sessions use the independent ACP adapter, including managed Provider configuration.
Pi ACP Provider integration is still pending. Credentials belong to their selected profile and
must never be copied into application resources. Do not infer OAuth or universal subscription
compatibility from the managed Provider interface.

## Internal build

```sh
corepack pnpm tauri:build:internal
```

This explicitly builds `Farfold.app` with the daily-use identity. It is locally ad-hoc signed and
has no configured update feed. Building it does not install it or prove internal acceptance;
follow `plans/runtime-neutral-lifemodel.md` for verification and controlled replacement.

## Authority

Read `AGENTS.md`, then `PRODUCT.md`, then `plans/runtime-neutral-lifemodel.md` before changing the
product. `plans/gate-0.md` and dated research/acceptance reports are historical evidence, not
current instructions or current support lists.
