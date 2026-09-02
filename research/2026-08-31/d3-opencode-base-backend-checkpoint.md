# D3 OpenCode Base backend checkpoint

Date: 2026-08-31
Runtime: OpenCode CLI `1.15.13`
Scope: pinned distribution, authenticated child Server lifecycle, and official HTTP/SSE transport
behind the Runtime seam; no OpenCode product UI or LifeModel C/U

## Result

The first two D3 backend slices are implemented and verified. Farfold can now locate only its pinned
OpenCode installation, own an authenticated loopback `opencode serve` child, verify the live
version, query Provider/model readiness, create/list native Sessions, submit an asynchronous prompt,
read native history, preserve raw SSE events, answer native permission requests, abort a Session,
and reap the Server.

This is engineering evidence, not D3 product acceptance. The current Farfold UI still selects and
runs Pi only, no installed application has completed an OpenCode journey, and the OpenCode
descriptor deliberately remains `Base=unverified`, `Contributes=unsupported`, and
`Uses=unsupported`.

## Implemented boundaries

- `scripts/fetch-opencode-sidecar.sh` freezes the official `v1.15.13` arm64 archive and SHA-256,
  verifies the extracted version, and records the extracted executable hash for later integrity
  checks.
- `src-tauri/resources/third-party/opencode-LICENSE.txt` bundles the required MIT notice.
- `opencode_runtime.rs` owns one child process, a 256-bit per-launch Basic Auth password, an explicit
  loopback high port with bounded collision retry, dedicated Farfold XDG data/cache/state paths,
  startup stdout plus authenticated health readiness, generation invalidation, bounded diagnostics,
  and stop/reap behavior.
- `opencode_protocol.rs` uses only the official Server routes for Provider, Session, prompt, history,
  permission, abort, and `/global/event` SSE. Native IDs are validated before becoming URL path
  segments; request errors never include credentials.
- SSE events are kept as loss-aware raw payloads in a bounded generation-tagged queue. Unknown future
  OpenCode events are not discarded or reinterpreted.
- `src/runtime/opencode.ts` exposes the typed Tauri boundary while keeping the OpenCode Runtime,
  installation, and Adapter identities distinct from Pi.

The process environment intentionally preserves OpenCode's native user/project configuration reach
recorded in `d3-opencode-entry-gate.md`; Farfold itself does not parse those files.

## Real Runtime proof

With `FARFOLD_OPENCODE_TEST_BINARY=/Users/tw/.opencode/bin/opencode`, the conditional Rust
integration test exercised the real local CLI:

- Server startup reached authenticated health on a Farfold-selected loopback port;
- Provider discovery reported a connected Provider and available model;
- native Session create and same-directory list returned the same Session ID;
- the SSE reader received native connection/Session/message/status events;
- `prompt_async` returned through the official route;
- this run then exposed OpenCode's native `429 FreeUsageLimitError` as
  `session.status=retry`, `reason=free_tier_limit`;
- the Adapter used the official abort route and then terminated/reaped the Server; the listener was
  closed.

The entry-gate probe earlier in the same environment completed model turns successfully. The later
rate limit is not treated as Adapter success or failure: it proves why Runtime process readiness,
Provider catalog readiness, account/quota state, and per-turn availability must remain separate and
why Provider failure must be visible in Farfold.

## Automated verification

The repository checks pass after this checkpoint:

- Prettier format check;
- TypeScript typecheck;
- Vitest: 12 files, 55 tests;
- Vite production build;
- Rust formatting;
- Clippy with `-D warnings`;
- Rust tests: 36 passed.

Focused coverage includes random Server credentials, authenticated version health, loopback port
selection, bounded diagnostics/events, start cancellation generation invalidation, native path ID
validation, Provider readiness separation, lossless unknown SSE events, immutable Runtime identity,
and a real OpenCode lifecycle/HTTP/SSE run when the explicit test binary is supplied.

## Remaining before D3 acceptance

- implement the frontend OpenCode Adapter projection and immutable Farfold/native Session binding;
- add the Farfold Runtime chooser and OpenCode identity/capability presentation without weakening
  Pi;
- render streaming text, tools, permission allow-once/reject, Provider errors, completion, Stop, and
  restart/resume in the Farfold UI;
- prepare the frozen official archive, build/sign/install a fresh app, and complete knowledge,
  coding, failure, restart, coexistence, and Pi regression journeys.

OpenCode LifeModel contribution and consumption remain excluded until D4.
