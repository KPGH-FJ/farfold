# Pi failure diagnosis — 2026-09-23

The installed candidate restored the existing Pi conversation with the expected model and thought setting, but the continuation did not produce the expected reply. This is a failed product sample, not a passed conversation journey.

## Direct ACP observation

`pi-failure-probe.py` reused the existing bounded probe, read the configured Agent command/args/env without logging credentials, and created a separate temporary project. It did not change the Agent, HOME, model, thought setting, or configuration. The currently selected options were checked before prompting:

- Adapter: installed `pi-acp` 0.0.33.
- Native Pi: installed `@earendil-works/pi-coding-agent` 0.80.5.
- Model: `zai-coding-cn/glm-4.5-air`; thought level: `off`.
- Result after about 38 seconds: three retry messages, one fixed retry-finished message, no requested marker.
- Prompt response contained only `stopReason: "end_turn"`; there was no error or `_meta` field.
- All probe-owned processes were gone after cleanup.

The sanitized observations are in `pi-failure-acp.json`. Its text buffer includes startup messages; the `other_response_text_present` field must not be interpreted as an actual prompt answer. The marker, retry counts, and terminal response shape are the relevant observations. This direct probe verifies the protocol boundary on a new temporary-project conversation; it does not substitute for the installed restored-conversation sample.

## Source boundary

Installed native source: `/Users/tw/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`. Installed adapter source: `/Users/tw/Library/Application Support/ai.farfold.desktop/agents/pi/0.0.33/node_modules/pi-acp/dist/index.js`.

Native Pi's `dist/core/agent-session.js:751-757` emits `auto_retry_end` with `success: false` and `finalError` when retries are exhausted, then ultimately emits `agent_settled`. The installed adapter's `dist/index.js`:

- At 1174–1180, ignores those error fields and always emits the ordinary text `Retry finished, resuming.`.
- At 947–1024, only forwards text, thinking, and tool-call message deltas; the error subtype is not forwarded.
- At 1212–1216, resolves a settled request as `end_turn` unless cancelled.
- At 2434–2436, also maps its internal `error` outcome to `end_turn` unless cancelled.

Farfold `failures.rs` accepts the public structured failure extension, and `pump.rs:574-580` applies it before recording the terminal result. `completion.ts:39-43` maps an unqualified `end_turn` to done. The direct sample proves that this adapter did not send a failure signal for Farfold to interpret. The underlying provider error remains unknown from this ACP response; the adapter discarded its error detail. Private Agent/provider logs were not read, so this report makes no claim about the provider, authentication, quota, or network cause.

No production workaround, Agent patch, model change, or English-text failure heuristic was applied. Correct failure propagation requires an official Agent/adapter protocol surface. Product acceptance remains open.
