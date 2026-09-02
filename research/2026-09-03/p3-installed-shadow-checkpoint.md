# P3 installed shadow checkpoint

Date: 2026-09-03
Initial source commit: `6099740`
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
- A real pinned-Pi contract test started Pi 0.84.3 in RPC mode, sent backend `get_state`, waited for
  the matching ID/generation/command response, validated the official state fields, terminated the
  child, and confirmed that this read-only probe created no Session file.
- The explicit bundled-OpenCode lifecycle contract test also passed against the pinned 1.15.13
  executable.

## Still open

The local Computer Use control pipe closed whenever it attempted to open the native Project folder
picker. The Farfold P3 QA process remained alive and the interface remained responsive, so this is
not product-crash evidence. Repeating the same automation path was stopped after three consistent
failures.

No Project was selected and no Runtime Session was started in this checkpoint. Therefore it does
not prove Pi/OpenCode projection parity, Channel gap recovery, Session reconciliation, stale
interaction recovery, or P3 exit. Polling remains enabled and P3 remains active.

## Release transport-parity checkpoint

Source commit: `f2ab4a1`

- Added a P3-build-only, content-free QA indicator. It reports sequence, exact fingerprint and
  multiplicity matches, unmatched Channel/polling counts, and reconciliation reasons. Formal
  Farfold builds do not enable the indicator.
- Rebuilt, signed, installed, and launched `/Applications/Farfold P3 QA.app`. Installed main
  executable SHA-256:
  `7474a04f8e57e2537b203583d92b8156052d6600360cca7e3ab1aec53a5eb83d`.
- The installed Pi and OpenCode SHA-256 values remained the pinned values recorded above.
- Used the isolated local Project `/tmp/farfold-p3qa-project-20260903`. This avoids treating the
  automation tool's inability to complete the macOS folder picker, or a QA-only path that has not
  received a security-scoped folder grant, as Runtime evidence.
- Pi 0.84.3 started in the installed release candidate, completed its bootstrap RPC exchange, and
  reached ready with `20 / 20` Runtime events matched between Channel and unchanged polling.
- Switching to OpenCode stopped Pi with the global ledger still matched. The candidate then started
  OpenCode 1.15.13 and reopened the exact existing native Session
  `ses_f9c6fefa9ffeARsf3raAANPTXq`; the final release-candidate ledger was `23 / 23`, with zero
  unmatched events, zero gaps, and no reconciliation reason.
- A preceding installed debug pass created that OpenCode Session and exercised Pi -> OpenCode -> Pi
  generation restart through `49 / 49` matched events. It is supporting diagnostic evidence, not a
  substitute for the release-candidate result.
- No prompt or task was sent to Pi, OpenCode, or any Provider during this checkpoint.

## Remaining P3 boundary

The installed release candidate now proves Runtime start/stop, Pi bootstrap responses, OpenCode
native Session reopen, cross-Runtime switch, and generation restart parity. It does not yet prove a
real user Turn, Runtime-native permission/dialog handling during a Turn, or installed recovery from
an injected sequence gap. Polling is still the visible-state authority and must not be removed until
the Channel cutover itself passes the same installed journeys.
