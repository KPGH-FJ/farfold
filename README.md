# Farfold

Farfold is a macOS personal desktop agent powered by the upstream Pi agent runtime.

The product is intentionally independent from OpenLife. It does not import OpenLife code,
data, runtime state, or architecture.

## Development

```sh
corepack pnpm install
corepack pnpm prepare:pi
corepack pnpm tauri dev
```

The Pi sidecar is pinned and checksum-verified by `scripts/fetch-pi-sidecar.sh`.

## Authority

Read `AGENTS.md`, then `PRODUCT.md`, then `plans/gate-0.md` before changing the product.
