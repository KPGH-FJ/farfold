# D3 OpenCode entry gate

Date: 2026-08-31
Candidate Runtime: OpenCode CLI `1.15.13`
Scope: distribution, official Server protocol, native configuration reach, legal terms, and
Farfold-owned child-process lifecycle before Adapter implementation

## Result

The D3 entry gate passes for OpenCode `1.15.13`, with one explicit native-behavior constraint:
OpenCode reads its normal user-level configuration in addition to a custom config directory. D3
must preserve and disclose that behavior; it must not claim that `XDG_*`, `OPENCODE_CONFIG_DIR`, or
`--pure` creates a fully isolated OpenCode configuration.

This gate authorizes implementation of the OpenCode Base Adapter only. It does not authorize
OpenCode LifeModel contribution or consumption, a second Farfold Agent loop, or any modification of
OpenCode.

## Frozen installation and distribution

The locally downloaded CLI is `/Users/tw/.opencode/bin/opencode`:

- version: `1.15.13`;
- architecture: Mach-O arm64;
- executable SHA-256:
  `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`;
- it is not on the current shell `PATH`;
- its ad-hoc/linker signature does not pass strict macOS signature verification.

`/Applications/OpenCode.app` is a separate, notarized Desktop distribution at version `1.17.9`.
Its presence does not provide the `opencode serve` executable Farfold needs, and D3 must not treat
the Desktop app as the CLI installation.

The D3 production source is frozen to the official GitHub release asset
[`opencode-darwin-arm64.zip`](https://github.com/anomalyco/opencode/releases/download/v1.15.13/opencode-darwin-arm64.zip)
from [`v1.15.13`](https://github.com/anomalyco/opencode/releases/tag/v1.15.13):

- asset size: `36,753,982` bytes;
- release API digest:
  `sha256:be369a38d15a22e83fad34874d1bc7ddead8084e07df292b28d079287d54ab0c`.

The existing local executable is valid development evidence for the recorded hash and protocol,
but it is not a product packaging source. D3 packaging must fetch the frozen official archive,
verify the archive digest before extraction, include it as a nested application resource, and let
the Farfold release-signing flow sign the final app bundle. No arbitrary executable discovered from
`PATH` may silently become the product Runtime.

## Official Server surface verified

The candidate was started only through the official `opencode serve` surface described in the
[OpenCode Server documentation](https://opencode.ai/docs/server/). The observed `1.15.13` OpenAPI
document at `/doc` reports OpenAPI `3.1.0` and exposes the expected official routes, including:

- `GET /global/health` and `GET /global/event`;
- `GET /provider`;
- `POST /session`, message history, and Session status;
- `POST /session/{sessionID}/prompt_async` and `/abort`;
- `POST /session/{sessionID}/permissions/{permissionID}`.

With a synthetic per-launch Basic Auth credential:

- no credential: `401` with `WWW-Authenticate: Basic`;
- wrong credential: `401`;
- correct credential: `200` and `{"healthy":true,"version":"1.15.13"}`;
- the SSE response was `text/event-stream` and delivered `server.connected`, heartbeat,
  `message.part.delta`, `message.part.updated`, `session.status`, and `session.idle` events;
- a native Session bound to the requested `directory` accepted `prompt_async` with `204`, streamed
  `D3-STREAM-END`, and returned the same completed text through official message history;
- `opencode/big-pickle` was connected, active, and zero-cost in the Provider response; a separate
  completed turn returned `D3-FROZEN-OK`;
- immediate abort returned `true` and Session status returned to idle.

The CLI help prints a `--port` default of `0`, but a real `--port 0` start listened on `4096`.
Therefore `0` is an internal default sentinel, not an operating-system-assigned ephemeral port.
Farfold must select a loopback high port, retry on bind collision, pass the explicit port, and
accept the connection only after authenticated health returns the frozen version.

## Native configuration reach

The first probe incorrectly assumed that `XDG_*` plus `--pure` isolated all OpenCode configuration.
Server logs disproved that assumption: OpenCode read user-level config paths under both
`~/.config/opencode` and `~/.opencode`.

The probe was repeated with a dedicated `OPENCODE_CONFIG_DIR` and dedicated XDG data/cache/state
directories. The same user-level reads remained, while the custom directory was also read. This is
consistent with the `v1.15.13` source: its
[`ConfigPaths.directories`](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/config/paths.ts)
always includes the home `.opencode` directory, and `OPENCODE_CONFIG_DIR` adds another directory.
`--pure` disables external plugin execution; it is not a configuration-read isolation contract.

D3 consequently freezes the following honest boundary:

- Farfold owns and isolates the Server credential, child process, selected port, and
  Farfold-specific data/cache/state directories;
- OpenCode retains its native user/project configuration lookup and Provider/model semantics;
- Farfold will never inspect or parse those config files itself, copy their credentials, or claim
  they are isolated;
- the UI must identify the connection as the OpenCode Runtime and expose Provider/model readiness
  separately from process readiness.

## Local process ownership

For each active OpenCode connection, Farfold owns one child `opencode serve` process:

1. resolve only the bundled, digest-verified CLI for the frozen installation;
2. generate a strong password in memory for the launch and pass it through
   `OPENCODE_SERVER_PASSWORD`;
3. bind only `127.0.0.1`, select and pass an explicit high port, and reject version mismatch;
4. treat stdout readiness plus authenticated `/global/health` as startup success;
5. scope every project request with the official `directory` query parameter;
6. stop and reap the child on connection shutdown/app exit, surface unexpected exit as Runtime
   failure, and support a bounded restart that resumes only the recorded native Session;
7. never attach to an arbitrary already-running OpenCode Server or the OpenCode Desktop app.

The probe confirmed the exact child command listened only on `127.0.0.1`; after an interrupt the
listener and process were gone. Server authentication, Provider readiness, native Session identity,
and Farfold Session identity remain separate state.

## License and product identity

OpenCode `v1.15.13` is distributed under the
[`MIT License`](https://github.com/anomalyco/opencode/blob/v1.15.13/LICENSE). Distribution is allowed
provided the copyright and permission notice is included with copies or substantial portions.
D3 must add that exact notice to Farfold's third-party notices and bundled resources.

OpenCode's
[`Building on OpenCode`](https://github.com/anomalyco/opencode/blob/v1.15.13/README.md#building-on-opencode)
note asks related products using `opencode` in their name to state non-affiliation. Farfold does not
use that name, but the product will still label the third-party Runtime accurately and must not imply
that Farfold is an official OpenCode product or partnership. Provider-specific accounts and terms
remain the user's separate Provider relationship.

## Gate decision and implementation constraints

All D3 entry conditions are now recorded:

- D2 remains complete and no Pi code changed during this gate;
- local CLI version and executable hash were reverified;
- official release source and archive digest are frozen;
- Basic Auth, OpenAPI, HTTP/SSE, prompt, history, completion, abort, and process shutdown were
  reverified against the installed CLI;
- applicable MIT notice and product-identity obligations are frozen;
- Farfold child-process ownership and the non-isolated native config reach are explicit.

The next work may implement D3 Base only. OpenCode must report `Base` from real connection evidence
and must remain `Contributes=no` and `Uses=no` until D4.
