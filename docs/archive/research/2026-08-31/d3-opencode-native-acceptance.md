# D3 OpenCode installed-app acceptance

Date: 2026-08-31
Status: passed
Scope: D3 OpenCode Base Adapter only

## Delivery truth

The accepted build is the separately installed macOS QA application:

- application: `/Applications/Farfold D3 QA.app`;
- bundle identifier: `ai.farfold.desktop.d3qa`;
- data directory: `~/Library/Application Support/ai.farfold.desktop.d3qa`;
- project: `/private/tmp/farfold-d3-native.MYHuXa`;
- final executable SHA-256:
  `7f6bedcd97a72c9436d71762143ebe7f1a855bc3d0a9501edd1e752ef02658ed`;
- bundled OpenCode SHA-256:
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`;
- bundled OpenCode version: `1.15.13`.

The executable in the release bundle and the executable installed under `/Applications` have the
same SHA-256. `codesign --verify --deep --strict` passes. The formal
`/Applications/Farfold.app` installation and its data directory were not replaced or reused.

The Provider credential used for native acceptance was supplied only to the QA application's
process environment. It was not written to Farfold source, fixtures, logs, or committed files.

## Product result

OpenCode now reports:

- `Base=yes`;
- `Contributes=no`;
- `Uses=no`.

`Base=yes` means this specific Adapter/version passed D3 Base operation in the installed QA app. It
does not imply OpenCode can contribute to, or consume, canonical LifeModel. Those remain D4
capabilities and stay disabled.

The final source changes also restore the exact OpenCode Provider/model from official assistant
message history and treat `models-dev.refreshed` as a passive Server event. Farfold does not pick
the first available model when the recorded model is unavailable.

## Full native matrix

The complete native matrix ran in the installed QA application immediately before Base promotion,
on executable SHA-256
`2d39733ff67f55786622707650cce6ff651801729a87f874d6f58201ecf5c9e8`.

### OpenCode

- Selected and recovered `GLM-5.3-Flash · zhipuai` from official native history.
- Completed a knowledge task by reading `reference.md` through the native read tool and returned
  `FINAL_OC_KNOWLEDGE_Hangzhou_42`.
- Completed a coding task through the native edit tool; shell verification confirmed
  `check.txt=FINAL_OC_CODING_OK`.
- Rejected one native permission request and allowed another once. `denied.txt` was absent and
  `allowed-once.txt=ALLOW_ONCE_OK`.
- Stopped a native long-running bash tool. After the command's original completion window,
  `final-oc-late.txt` was absent.
- Surfaced a synthetic Provider connection failure in the Farfold UI, stopped it, switched back to
  the real Provider/model in the same native Session, and returned
  `FINAL_OC_PROVIDER_RECOVERY_OK`.
- Restarted the Farfold-owned OpenCode Server and resumed the same native Session, exact
  Provider/model, and official message history.
- Quit and relaunched the QA application, then resumed the same native Session and model.

### Pi regression

- Read `source-a.md`, `source-b.md`, and `check.txt`, wrote `pi-final.txt`, reread it, and returned
  `FINAL_PI_FILE_OK`; shell verification confirmed
  `ALPHA+BRAVO+FINAL_OC_CODING_OK`.
- Stopped a native long-running bash tool. After the command's original completion window,
  `final-pi-stop-late.txt` was absent.
- Queued a deterministic steering message during a 30-second native tool call. The UI showed
  `已接收转向 · 将在当前工具完成后应用`, and the resulting assistant message was
  `FINAL_PI_STEER2_OK` without the superseded original final.
- Queued a deterministic follow-up during a 30-second native tool call. The UI showed
  `已加入跟进 · 将在当前任务完成后执行`; the primary assistant message arrived before the
  persisted follow-up user message. The model echoed both validation tokens in the follow-up
  response, so this proves queue order and persistence, not strict output-token isolation.
- Quit and relaunched the QA application, then resumed the same native Session and history.

One earlier diagnostic Pi follow-up encountered a surfaced Provider timeout and recovered. It was
not counted as a successful follow-up result and did not indicate a hidden Farfold success.

## Session and process isolation

- Pi native Session: `01a05653-40e6-7c1d-bd5f-9e8f3772f6f9`.
- OpenCode native Session: `ses_fa9baa7bbffec3jdjdT75sBOfn`.
- Both Sessions use the same project but retain different native identifiers, histories, Runtime
  bindings, and Provider state.
- Exiting the application reaped the Pi capability bridge, Pi Runtime, and OpenCode Server child
  processes.

## Final-hash targeted regression

After Base promotion, the final executable hash
`7f6bedcd97a72c9436d71762143ebe7f1a855bc3d0a9501edd1e752ef02658ed` received a targeted installed
regression proportional to the declaration-only promotion:

- OpenCode visibly showed `Base=yes Contributes=no Uses=no`;
- the same OpenCode Session restored `GLM-5.3-Flash · zhipuai` and complete official history;
- OpenCode used its native read tool and returned `FINAL_BASE_PROMOTION_OC_OK`;
- the same Pi Session and history resumed and returned `FINAL_BASE_PROMOTION_PI_OK`;
- switching back to OpenCode again restored the same model, Session history, and capability labels;
- final app exit left no Farfold QA, Pi capability, Pi Runtime, or OpenCode Server process running.

The full matrix and final-hash targeted regression together are the D3 installed-app evidence. The
final hash was not credited with rerunning every long-duration destructive/abort scenario; the
report preserves that distinction instead of treating the prior hash as identical evidence.

## Repository verification

The promoted source passed:

```text
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test                13 files, 64 tests
corepack pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked   40 tests
```

Vite emitted its existing chunk-size advisory; it did not fail the build.

## Remaining boundary

D3 is complete. D4 has not started. No OpenCode path can create canonical LifeModel state or receive
LifeModel injection. The next phase must independently verify the official C1 and U1 surfaces in
the product Adapter and preserve the existing source -> Proposal -> user approval -> canonical
LifeModel contract.
