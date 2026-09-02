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

## Release visible-state Channel cutover checkpoint

Source commit: `37cf98a`

- Pi and OpenCode visible reducers now consume validated native envelopes from the Host Channel.
  Formal builds no longer call either Runtime event poller. The isolated P3 QA build retains those
  pollers only as content-free comparison probes; they do not drive visible state.
- Rebuilt, signed, installed, and launched `/Applications/Farfold P3 QA.app`. Installed main
  executable SHA-256:
  `1d0887b74f3b684b5cd6fe1526ac703623eb5cc5e0be0d26ad8737766f61b4bd`.
- The installed Pi Runtime SHA-256 remained
  `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`; OpenCode remained
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`.
- In the installed release candidate, Pi moved from stopped to ready through Channel-driven UI
  updates and reached `20 / 20` parity. Switching to OpenCode stopped Pi and reached `21 / 21`.
- Reopening exact OpenCode native Session `ses_f9c6fefa9ffeARsf3raAANPTXq` restored the bound
  Session and displayed OpenCode ready at `24 / 24`, with zero unmatched events, gaps, or
  reconciliation reasons.
- No prompt, task, or Provider request was sent during this checkpoint. The formal
  `/Applications/Farfold.app` bundle was not replaced.

## Current remaining P3 boundary

The cutover release candidate proves that installed Pi/OpenCode start, stop, Runtime switch, and
exact native Session reopen no longer depend on polling-driven visible reducers. P3 remains active:
an installed injected-gap recovery journey, a real user Turn, and a Runtime-native
permission/dialog interaction journey are still required. QA-only comparison polling remains in
place until those recovery and interaction gates pass.

## Release automatic-reconciliation checkpoint

Source commit: `df5ff4b`

- Subscription Ready now carries the LiveSessionProjection and pending-interaction snapshot from
  the same router-locked sequence cut. Rust serialization tests lock the exact camelCase Tauri
  fields, including the repaired `pendingInteractions` delivery name.
- Transport/projection uncertainty now creates monotonic recovery revisions scoped to the exact
  Runtime installation. The UI pauses sends, mutable Runtime/Project/model selection, LifeModel
  mutation, and Runtime-native interaction replies until official reconciliation and visible-state
  hydration both succeed.
- Rebuilt, signed, installed, and launched `/Applications/Farfold P3 QA.app`. Installed main
  executable SHA-256:
  `a59856d10d026f987bc4b6093487eccd85f9200f2b5b0b49273dca35adc022f2`.
- Bundled Pi and OpenCode Runtime SHA-256 values remained the pinned values recorded above. Formal
  `/Applications/Farfold.app` remained unchanged, with main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- The installed release candidate restarted Pi into a newer generation, queried correlated
  `get_state` / `get_messages` / `get_state`, rehydrated the visible Pi state, and reached
  `2` acknowledged recoveries with `50 / 50` transport parity.
- It then restarted OpenCode, verified the exact native Session
  `ses_f9c6fefa9ffeARsf3raAANPTXq` through official Session list/messages surfaces, rehydrated the
  visible conversation, and reached `3` acknowledged recoveries with `53 / 53` parity.
- No prompt, task, permission response, or Provider request was sent.

P3 remains active. This checkpoint proves installed generation-change recovery and exact native
Session rehydration. It does not substitute for an installed injected sequence-gap recovery or a
real Runtime-native permission/dialog journey.

## Release sequence-gap recovery checkpoint

Source commit: `85e7e23`

- The P3 QA build now compiles its Runtime event router with an eight-event ring and exposes a
  QA-only gap action. The action pauses the Channel consumer, captures its cursor, produces more
  than eight events by calling the read-only official Pi reconciliation surface four times, drains
  the unchanged QA polling probe, and reconnects from the stale cursor. The formal/default router
  still uses its 2,048-event capacity and formal builds expose neither the action nor polling.
- Reconciliation request identity includes the Host-shadow consumer generation, so a second gap in
  the same Host stream and Runtime generation cannot collide with the preceding recovery request.
  Global stream/gap evidence marks only live Runtime projections; the inactive OpenCode projection
  is not put into reconciliation by a Pi-only gap.
- Frontend format, typecheck, 16 test files / 89 tests, and production build passed. Rust format,
  Clippy with warnings denied, and 97 tests passed.
- Rebuilt from clean commit `85e7e231086427a20e4c19dace0ab77573653d6b`, signed, installed, and
  launched `/Applications/Farfold P3 QA.app`. `codesign --verify --deep --strict` passed. Installed
  main executable SHA-256:
  `ef3f4ef81ce1dd9ebc813eb07dd17c4d43dca854a49aa311e16714174bf78a83`.
- The bundled Pi resource remained
  `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`; OpenCode remained
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`. Formal
  `/Applications/Farfold.app` remained unchanged at main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- The installed candidate started Pi and reached `20 / 20` parity at sequence `20`. Its first
  injected gap automatically reconciled and rehydrated to `2` acknowledged recovery revisions,
  `17 / 17` parity, sequence `41`. Repeating the injection in the same installed process again
  converged with no pending reconciliation or parity mismatch at sequence `62`.
- No prompt, task, Runtime-native interaction reply, or Provider request was sent. The replaced QA
  bundle remains recoverable from `/tmp/Farfold P3 QA.pre-85e7e23-20260903-0421.app`.

P3 remains active. Installed sequence-gap recovery now passes, including repeat recovery in one
process. A real user Turn and a Runtime-native permission/dialog journey are still required before
QA polling can be removed and P3 can be accepted.

## Release Runtime-native interaction checkpoint

Source commit: `d6f968a`

- Added a P3-QA-only Pi Extension loaded through Pi's documented `--extension` interface. It
  registers `/farfold-p3qa-confirm`, whose handler calls `ctx.ui.confirm()` and then
  `ctx.ui.notify()`. Formal builds do not load this Extension.
- Rebuilt from clean commit `d6f968adcf141c21a2afb2967b35f9a6844c6064`, signed, installed, and
  launched `/Applications/Farfold P3 QA.app`. `codesign --verify --deep --strict` passed. Installed
  main executable SHA-256:
  `dcce097d0c7521d4dd7399de49338ffd217f56a42fcb54519cbc8d3f4f216b60`.
  The installed QA Extension SHA-256 was
  `f84f8264c6650079ad04443b56ccabe3b664524425c706f503c189e8bb23b7f1`.
- Formal `/Applications/Farfold.app` remained unchanged at main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.
- After installed Pi reached `20 / 20` parity at sequence `20`, typing `/farfold-p3qa` exposed one
  official Pi command match: `/farfold-p3qa-confirm`, described as an Extension command that
  exercises the RPC confirmation channel without an LLM turn.
- Executing that exact registered command produced the Pi-native confirmation dialog titled
  `P3 Runtime 原生交互检查`. Choosing `否` sent the response through the
  generation-scoped InteractionRegistry and Pi emitted `P3 QA：原生确认已拒绝`. Final parity was
  `23 / 23` at sequence `23`, with zero unmatched events and no pending reconciliation.
- The visible context stayed at zero and the isolated Pi Session directory contained no JSONL
  Session file. No Provider request, agent prompt, tool, or permission grant was made.

P3 remains active. The installed Runtime-native dialog/reply journey now passes. One real
Provider-backed user Turn and removal of the QA-only polling comparison path remain before P3 exit.

## P3 closure: real Turn and Channel-only installed acceptance

Provider-Turn source commit: `d6f968adcf141c21a2afb2967b35f9a6844c6064`

- With explicit authorization, the installed Pi 0.84.3 candidate sent the exact prompt
  `仅回复 FARFOLD-P3-TURN-OK，不使用工具。` to Z.AI GLM-5.3-Flash once. The native Session
  recorded the exact response `FARFOLD-P3-TURN-OK`, API `openai-completions`, Provider `zai`,
  model `glm-5.3-flash`, stop reason `stop`, no tool call, 1,710 total tokens, and total reported
  cost `0.00013035`.
- Host Channel/polling parity advanced from `23 / 23`, sequence `23`, to `46 / 46`, sequence `46`.

Channel-only source commit: `885a7ca29838e9fe2ab98578dfdb984228b0f89f`

- Removed all frontend Pi/OpenCode Runtime event-polling calls and the temporary parity fingerprint
  ledger. Legacy Adapter read endpoints remain non-authoritative surfaces for retirement only after
  formal same-build promotion.
- Frontend format, typecheck, 16 test files / 84 tests, and production build passed. Rust format,
  Clippy with warnings denied, and 97 Rust tests passed.
- Rebuilt, signed, installed, and launched `/Applications/Farfold P3 QA.app` from the clean commit.
  `codesign --verify --deep --strict` passed. Installed main executable SHA-256:
  `1f6ac22c0624835bb83663b8718b7d1b8a2012d77e91341b751755831a4329e7`.
- The installed candidate reopened the exact Pi Session containing the authorized Turn and rendered
  it at sequence `20`; recovered an injected ring gap without polling at `2` acknowledged recovery
  revisions, sequence `41`; and completed the Pi-native confirmation dialog at sequence `44`.
- It then switched Runtime and reopened exact OpenCode native Session
  `ses_f9c6fefa9ffeARsf3raAANPTXq` at sequence `48`, without sending an OpenCode prompt or Provider
  request.
- Bundled Pi SHA-256 remained
  `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`; OpenCode remained
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`.
- Formal `/Applications/Farfold.app` was not replaced and remained at main executable SHA-256
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`.

P3 is complete. This is isolated QA acceptance, not formal product promotion; current shipped
claims remain Pi-only.
