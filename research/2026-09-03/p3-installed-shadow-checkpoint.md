# P3 installed shadow checkpoint

Date: 2026-09-03
Source commit: `6099740`
Scope: isolated installed-app entry evidence; this is not P3 acceptance

## Verified

- Built `Farfold P3 QA.app` with the isolated identifier `ai.farfold.desktop.p3qa`.
- Installed it at `/Applications/Farfold P3 QA.app` without replacing formal Farfold or the running
  D3 QA application.
- `codesign --verify --deep --strict` passed.
- Installed main executable SHA-256:
  `92a3fc14f745e92aa11b619d99277b966971e6fa75657fe707b18115d046a772`.
- The verified Pi Runtime resource SHA-256 remains
  `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`; the signed
  `Contents/MacOS/pi` file is the wrapper that `exec`s this resource.
- The installed OpenCode Runtime SHA-256 remains
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`.
- The installed native application launched and rendered the expected Pi-first start surface with
  its isolated empty Session index. Existing Runtime-owned Provider/model configuration remained
  visible without being copied into Host storage.

## Still open

The local Computer Use control pipe closed whenever it attempted to open the native Project folder
picker. The Farfold P3 QA process remained alive and the interface remained responsive, so this is
not product-crash evidence. Repeating the same automation path was stopped after three consistent
failures.

No Project was selected and no Runtime Session was started in this checkpoint. Therefore it does
not prove Pi/OpenCode projection parity, Channel gap recovery, Session reconciliation, stale
interaction recovery, or P3 exit. Polling remains enabled and P3 remains active.
