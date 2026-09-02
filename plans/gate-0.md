# Gate 0 — Pi-native personal Agent (completed archive)

Status: completed on 2026-08-29 and archived on 2026-08-31. This file preserves Gate 0 evidence;
the only active development plan is `plans/runtime-neutral-lifemodel.md`.

## F0 — Clean foundation

- Independent repository, remote, app identity, and data directory
- Tauri 2 + React macOS application
- Pinned and checksum-verified Pi sidecar
- Minimal typed runtime boundary

## F1 — Runtime lifecycle

- Start Pi in RPC mode for the selected Project
- Parse JSONL without corrupting Unicode or merging records
- Send commands, surface events and diagnostics, stop the process, and recover from termination

## F2 — Native conversation

- Pi-native Provider, model, authentication, Session, and streaming behavior
- New Session and resume existing Session
- User/Agent messages and tool activity rendered from Pi events

Status (2026-08-29): passed in the installed application with Z.AI GLM-5.3-Flash.

## F3 — Real work

- Project folder maps to Pi cwd
- Pi-native project trust and resource discovery
- Coding task modifies and verifies files
- Non-coding task reads multiple documents and produces Markdown

Status (2026-08-29): passed in an isolated Project selected through the installed application.

## F4 — Control and continuity

- Abort in-flight work
- Steering and follow-up use Pi semantics
- App restart resumes the same Pi Session
- Errors remain explicit and recoverable

Status (2026-08-29): passed for abort, steering, follow-up, restart, and explicit recovery state.

## F5 — Exact native acceptance

All ten scenarios must pass in the installed macOS app:

1. First launch reaches a real Provider and model.
2. A new Session completes a knowledge question.
3. A real Project folder is selected and Pi project trust is honored.
4. Pi reads Project resources, including applicable AGENTS and Skills.
5. A coding task modifies files and verifies the result.
6. A non-coding task reads multiple documents and creates a Markdown result.
7. Stop prevents continued execution.
8. Steering changes the in-flight direction through Pi semantics.
9. Restart resumes the same Pi Session.
10. All evidence comes from the formal Tauri application, not a browser or standalone CLI.

Status (2026-08-29): all ten scenarios passed in `/Applications/Farfold.app` with a real Provider.

## Completion Rule

Stages advance only on working product evidence. Agent coding time is recorded as diagnostic
information, not used as a deadline or as a substitute for scope and acceptance.

## UX completion track — completed 2026-08-29

### Objective and boundary

Deliver one polished macOS Farfold experience for a single local Pi Agent: a user can understand
what Project/Provider/model will be used, start or resume work, follow real Pi activity, intervene
without losing context, and return to the resulting Session. Completion is determined only by the
newly installed Tauri app and real Pi events.

This track improves the presentation of Pi-native facts. It does not add an Agent loop, custom
permission modes, artificial tool/diff/checkpoint data, cloud/background Agents, multi-Agent work,
or LifeModel.

### Product bar

The UI must make these six real states legible at a glance:

1. **Before work:** selected Project, applicable Project inputs, startup choice, Provider/model
   readiness, and whether a prior Session can resume.
2. **Starting:** an explicit transition rather than a frozen or prematurely-ready screen.
3. **Working:** streamed answer, current/finished Pi tools, elapsed state, and a clear Stop action.
4. **Intervening:** steering and follow-up are distinguished using Pi's actual semantics; queued
   intent remains visible.
5. **Finished or failed:** the answer and tool evidence remain readable; Provider/runtime failure
   names the recovery action without pretending the task completed.
6. **Returning:** Sessions remain searchable and project-scoped, automatic titles are safe, and
   deliberate user titles survive restart.

### Ordered work

#### UX-0 — truth and native regression (passed)

- Keep project trust as Pi's input-loading guard, never a sandbox claim.
- Show the locally discoverable Project sources that Pi can act on; show paths as relative sources.
- Keep automatic and manually chosen Session names distinct; serialize lifecycle-changing actions.
- Verify the six P1 regression cases below in the formal app.

Native result: all six P1 cases passed in the installed app, including the complete nested ancestor
resource inventory and rapid startup-choice switching.

#### UX-1 — visual baseline and navigation

- Audit the real app at 1024px and 1440px desktop widths against the established warm, restrained
  shell. Fix only observed hierarchy, density, overflow, focus, contrast, or interaction defects.
- Preserve the persistent Session/Project rail, searchable Sessions, compact header, and
  bottom-anchored composer. Do not create mock history to make the product look busier.

Native result: passed with the real Session history at a 1022px captured window (the macOS frame
around the 1024px target), the display's Fill/full-screen size, and a stricter 816px half-screen
check. Long Session/Project names truncate without hiding their full path, the Project list scrolls,
the conversation title remains visible, and the composer remains anchored and usable.

#### UX-2 — trustworthy work surface

- Verify that actual Pi streaming, tool steps, thought disclosure, Markdown/code, Stop, steering,
  and follow-up have a single clear visual hierarchy in both short and multi-tool tasks.
- Keep detail progressively disclosed: compact progress by default, raw tool output and thinking
  available on demand. No inferred “diff”, completion score, or checkpoint is shown unless Pi
  reports it.

Native result: passed with a short real response, a five-step read/write/read task, an aborted
`sleep` tool, in-flight steering, and queued follow-up. Tool-only assistant envelopes are now folded
into one five-step Pi activity group instead of producing blank Farfold rows; failure and compaction
notices remain explicit.

#### UX-3 — model and connection confidence

- Verify the cold start, model picker, thinking level, Provider search/login/custom-local setup,
  and validation states with real Pi capability data.
- Keep “configured”, “validated in this app run”, unavailable, and failure states distinct. A
  successful ordinary Pi response may update the current-run validation, but no stale success is
  presented as a live guarantee after restart.

Native result: passed. Cold start resolves to Z.AI / GLM-5.3-Flash after capability loading; the
picker exposes Pi's 1,315-model catalog and the selected model's low/high/max thinking levels.
Z.AI reached current-run success through a real turn, while DeepSeek's real four-token probe stayed
visibly distinct as `402 Insufficient Balance` failure. Restart returned both to configured but
unverified, as required.

#### UX-4 — final interaction and accessibility pass

- Exercise keyboard focus, Escape dismissal, Command-K Session search, command-menu keyboard
  selection, disabled/busy controls, and readable error recovery in the formal app.
- Capture real screenshots only for initial, ready, working, intervention, completed, failed, and
  resumed states. If a state cannot be reached with the real Provider, record the gap rather than
  injecting fixtures.

Native result: passed for Provider/model initial focus, Escape dismissal and focus return,
Command-K Session search, empty search results, slash-command dismissal without losing the draft,
busy/disabled controls, Stop recovery, configured/success/failure connection states, and resumed
multi-tool history. The Provider focus-return defect found during final regression is covered by a
focused unit test and was reverified in the reinstalled app.

#### UX-5 — release evidence and user acceptance

- Re-run all F5 scenarios plus the six P1 cases against the newly installed and signed app.
- Verify its bundle identity and executable hash against the built artifact before calling the
  experience ready for user acceptance.
- Stop and ask before overwriting the user's installed app, broadening the product scope, or
  encountering a Pi capability that has no truthful presentation path.

Native result: ready for user acceptance. `/Applications/Farfold.app` has bundle identifier
`ai.farfold.desktop`, passes `codesign --verify --deep --strict`, and its installed executable
matches the built artifact at SHA-256
`cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`. The local build uses an
ad-hoc signature and is not notarized; no Developer ID release claim is made.

### Benchmark rules

- Borrow the information hierarchy visible in leading Agent products: active work status, explicit
  queue/steer controls, Session navigation, model/context visibility, and reviewable work traces.
- Treat upstream Pi as the semantic authority. Farfold may name and group its events in Chinese;
  it must not invent modes, permissions, approvals, tool intent, or task results.
- A UI change is accepted only when its source/test boundary passes and the corresponding real
  native-app state has been visually inspected.

## Current Checkpoint — 2026-08-29

- F1 host stabilization is implemented: serialized lifecycle states, generation-scoped events,
  intentional-stop semantics, child reaping, and recoverable atomic Session pointers.
- F2 native conversation passed with the Pi-native `zai` / `glm-5.3-flash` default. A new Session
  returned `FARFOLD-GLM53-OK`, a separate knowledge Session returned `巴黎`, and an app restart
  restored the same Session with user and Agent messages in Pi order.
- The installed application starts, stops, restarts, and resumes the same Pi Session. The earlier
  DeepSeek credential still reports `402 Insufficient Balance`, while Z.AI GLM-5.3-Flash now
  supplies the successful real-Provider acceptance path.
- The former Farfold-owned ten-Provider/API-key implementation has been removed. A pinned
  `@earendil-works/pi-coding-agent` 0.84.3 capability bridge now exposes the exact Pi Provider,
  authentication, model, availability, default-model, and thinking-level contracts to Tauri. The
  current native catalog contains 40 Providers and over 1,300 models, including Pi OAuth and
  extended `xhigh`/`max` thinking support where the selected model exposes it.
- Provider setup delegates API-key and OAuth interaction to Pi, opens OAuth URLs in the macOS
  system browser, never returns stored secrets, and restarts the same Project/Session after a
  credential change. Credential mutation remains locked while an Agent request is active.
- An Advanced form covers the common custom/local-model case without inventing a registry: it
  validates a bounded Pi 0.84.3 `models.json` shape, preserves unrelated providers and models,
  blocks accidental built-in Provider replacement, writes atomically with `0600` permissions, and
  keeps remote credentials in Pi auth rather than embedding them in `models.json`.
- Provider state is explicit: configured is not treated as verified. A user-triggered probe makes
  a real request capped at four output tokens, while ordinary Pi responses also update the latest
  verified-success or verified-failure state. DeepSeek still fails with `402 Insufficient Balance`;
  Z.AI completed real Agent turns successfully.
- RPC requests now complete only after a correlated Pi `response`; pending requests fail on timeout,
  termination, or runtime-generation changes. A successful stdin write is no longer treated as Pi
  acceptance.
- The native UI separates Pi process, Provider configuration, Provider validation, and Agent work
  state; provides searchable Provider and model surfaces; discovers Pi commands for slash
  completion; renders safe Markdown/thinking/tool detail; and allows idle Project switching.
- A cold-start projection bug that showed the first configured Provider instead of Pi's default
  model Provider was reproduced in the installed app, covered by a regression test, and fixed. The
  cold card and model header now both resolve to Z.AI / GLM-5.3-Flash.
- F3 passed in an isolated Project: Pi modified and re-read `check.txt`, read two Markdown inputs,
  created and re-read `result.md`, and honored the `AGENTS.md` marker `AGENTS-READ`.
- Pi project trust remains Pi-native. With saved/default trust and no saved decision, AGENTS context
  loaded but protected `.pi/skills` did not. With the explicit one-run approval, `get_commands`
  exposed the Project Skill and `/skill:gate0-marker` expanded through Pi and returned `SKILL-READ`.
- F4 passed in the installed app: abort produced `Command aborted` and no late completion, steering
  changed `ORIGINAL` to `STEERED`, follow-up preserved `FIRST` then `FOLLOW-UP`, and restart restored
  the same Pi Session.
- F5 passed all ten formal native scenarios in `/Applications/Farfold.app`. Browser, fixture-only,
  and standalone CLI evidence were not used as substitutes for the installed application.
- The UX completion regression passed in the final reinstalled app: 39 frontend tests and 17 Rust
  tests pass; Stop, steer, and follow-up were exercised with real Pi turns; a five-tool saved Session
  resumes as one compact activity group with no blank assistant rows; Provider and model dialogs
  return keyboard focus to their triggers.
- A final smoke was repeated after the executable reached the hash below: a new knowledge Session
  returned `巴黎`; a four-step Project task read both nested/parent instructions, wrote and re-read
  `final-gate0-check.md`, and returned `FINAL-FILE-OK`; Stop prevented the requested late marker;
  steering replaced `FINAL-ORIGINAL` with `FINAL-STEERED`; quitting, relaunching, and choosing
  “继续对话” restored that same Session and result.
- The final installed executable hash is
  `cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`. The app is locally ad-hoc
  signed and passes strict code-sign verification; notarization remains outside this local Gate 0
  acceptance run.

## P1 trust-presentation regression — 2026-08-29

The current source adds a more exact Pi-native project-start presentation. Source checks and all
six native cases below passed in the newly installed app:

1. Select a nested Project with a parent `AGENTS.md`, a parent `.agents/skills`, and local
   `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and `.pi/themes`; verify the card lists the relative
   sources.
2. Select “不载入受保护项目资源（仅本次）”; verify both the card and running strip say this is
   an input-loading choice, not a file or command restriction.
3. Start the same Project and verify its Project Skill is absent from Pi commands; switch to
   “载入受保护项目资源” and verify the restarted Pi exposes that command.
4. Change the startup choice rapidly while idle; verify one restart completes and its final
   wording and command list match the final selection.
5. Start a new Session from a prompt containing a local Markdown or `file://` path; verify the
   automatic title omits the path.
6. Rename that Session to a visible title containing `/docs`; restart and verify the manual title
   remains unchanged apart from display-length truncation.

Native evidence recorded 2026-08-29: the installed app displayed parent `../AGENTS.md`, local
`AGENTS.override.md`, `.pi/skills`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and parent
`../.agents/skills`. Both explicit resource choices produced the expected command difference. Rapid
approve → ignore → saved → approve switching settled on the final approved wording and two Project
commands without a stale restart. The source-level regression refuses a transient, not-yet-listed
session path when restarting Pi. Automatic path omission, manual `/docs` title preservation, and
restart persistence were also checked in the installed app.

Open formal cases: none.
