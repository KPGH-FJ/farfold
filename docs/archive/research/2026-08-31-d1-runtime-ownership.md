# D1 Runtime ownership map

This map records the D1 call path implemented on 2026-08-31. It is descriptive source evidence,
not a second active plan.

## One call path

```text
React App
  -> piRuntimeAdapter (typed RuntimeAdapter boundary)
  -> Tauri runtime_* commands (stateless runtime_host facade)
  -> pi_runtime implementation
  -> Pi 0.84.3 RPC sidecar
```

`PiRuntime` is the sole lifecycle owner. It owns the child process, lifecycle generation, event
queue, active Project/session directory, and Farfold's last-Pi-session pointer. `runtime_host` owns
none of that state and does not implement an Agent loop.

Pi remains authoritative for its native Session JSONL, Provider/model selection, Project resources,
Skills, Extensions, tools, compaction, steering, follow-up, abort, resume, and permission behavior.
The Adapter adds identity and typed transport boundaries; it does not reinterpret those semantics.

## Command ownership

| Tauri command               | Frontend Adapter operation      | Implementation owner                  | Durable/native owner           |
| --------------------------- | ------------------------------- | ------------------------------------- | ------------------------------ |
| `runtime_discover`          | `discover`                      | `runtime_host` descriptor             | pinned Farfold distribution    |
| `runtime_status`            | `status`, `connectionReadiness` | `pi_runtime` status projection        | `PiRuntime` lifecycle          |
| `runtime_start`             | `start`/recovery options        | `pi_runtime` process start            | `PiRuntime`; Pi native Session |
| `runtime_stop`              | `stop`                          | `pi_runtime` process termination      | `PiRuntime`                    |
| `runtime_send`              | `send`, `cancelTurn`            | `pi_runtime` JSONL writer             | Pi RPC loop                    |
| `runtime_poll_events`       | `pollEvents`                    | `pi_runtime` bounded event queue      | `PiRuntime`; Pi event payload  |
| `runtime_list_sessions`     | `listSessions`                  | `pi_runtime` read-only summaries      | Pi Session JSONL               |
| `runtime_remember_session`  | `rememberSession`               | `pi_runtime` validated pointer update | Pi JSONL plus Farfold pointer  |
| `runtime_project_readiness` | `projectReadiness`              | `pi_runtime` read-only Project scan   | Project files and Pi rules     |

The separate `pi_capabilities_*` bridge remains the owner of Pi-native Provider/model/account setup.
It is not an Agent Runtime and does not own prompts, Sessions, or the Pi process above.

## Identity and degradation

- Runtime product, bundled installation, and Adapter identities are distinct fields.
- A listed Session receives immutable Farfold binding metadata from its Pi native Session ID; the
  binding is not written into or used to migrate Pi JSONL.
- Every polled event retains its generation, kind, raw payload, and Runtime identity.
- Documented Pi events may intentionally have no visible projection. A truly unknown event receives
  an explicit fallback notice and is not reinterpreted as a known event.
- Base is currently verified for Pi. Contribution to and consumption from LifeModel remain
  unverified; D1 adds no LifeModel persistence or OpenCode path.

## Verification evidence

The release build produced and ad-hoc signed this application bundle:

`src-tauri/target/release/bundle/macos/Farfold.app`

Executable SHA-256:

`5ba594a48d14b88ed697585bafeb7c9eba6da6b6402aad57903ddf469588b630`

The bundle was launched directly as a native macOS application. The following same-bundle journeys
passed through Farfold's UI and the Pi 0.84.3 sidecar:

| Journey         | Current evidence                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation    | `FARFOLD-D1-ADAPTER-OK` returned after a correlated `prompt` response                                                                                               |
| Project work    | Pi read current and parent Project fixtures and returned `# P1 nested Project instructions \| # P1 ancestor instructions \| FINAL-GATE0` with three tool executions |
| Steering        | a queued steer replaced the post-tool answer with `STEERED-D1`                                                                                                      |
| Follow-up       | the UI and Pi queue preserved `FIRST-D1` then `FOLLOWUP-D1` ordering                                                                                                |
| Stop            | Pi returned `Request was aborted`; `SHOULD-NOT-APPEAR-D1` was not emitted                                                                                           |
| Process failure | terminating only this bundle's Pi child produced `Pi sidecar 异常退出（code 143）`                                                                                  |
| Restart/resume  | Continue restarted Pi, restored the same native history, then returned `RECOVERED-D1`                                                                               |

The first UI attempt was invalidated because the older `/Applications/Farfold.app` and the new
bundle were both running under the same product name and bundle identifier. Process-path inspection
identified the two executables. After closing only the new bundle and relaunching its exact path with
RPC diagnostics, every command write, event-queue drain, response correlation, and UI projection
above completed. No product-code change was made for that harness ambiguity.

Repository checks after the D1 code changes:

- `corepack pnpm format:check`
- `corepack pnpm typecheck`
- `corepack pnpm test` — 45 passed
- `corepack pnpm build`
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` — 20 passed
