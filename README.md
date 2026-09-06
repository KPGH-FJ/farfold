# Farfold

Farfold is a macOS personal desktop agent powered by the upstream Pi agent runtime.

The product is intentionally independent from OpenLife. It does not import OpenLife code,
data, runtime state, or architecture.

## Development

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

The development build's OpenCode connection settings can save or remove API-key authentication
through OpenCode's native server. Changes reconnect the same Host-bound Session. These credentials
belong to the selected Farfold profile, separate from the shared OpenCode CLI configuration; never
copy them into application resources. OAuth and connections requiring additional parameters are
not yet available through this settings page.

## Internal candidate

```sh
corepack pnpm tauri:build:internal
```

This explicitly builds `Farfold.app` with the daily-use identity. It is locally ad-hoc signed and
has no configured update feed. Building it does not install it or prove internal acceptance;
follow `plans/runtime-neutral-lifemodel.md` for verification and controlled replacement.

## Authority

Read `AGENTS.md`, then `PRODUCT.md`, then `plans/gate-0.md` before changing the product.
