# D2 Pi C1/U1 entry gate

Date: 2026-08-31
Runtime: bundled Pi `0.84.3`
Scope: isolated official-surface proof before D2 product implementation

## Result

Both D2 entry conditions passed without reading Pi's private JSONL format and without modifying Pi.

## C1 — durable user source

The isolated RPC Session first invoked the Farfold test Extension command
`/farfold-lifemodel-anchor`. The Extension reported the current native leaf through Pi's official
`ctx.sessionManager.getLeafId()` and `ctx.ui.setStatus()` surfaces.

After the completed user turn `这是我的明确偏好：我偏好简洁回答。请只回复 C1-OK。`, the official
`get_entries` RPC with the reported leaf as `since` returned:

- the complete user-authored text;
- stable user entry ID `d0a6ee0b` and parent ID `fd583bf6`;
- stable assistant entry ID `dc600b2c`;
- resulting leaf ID `dc600b2c`.

The official `get_state` RPC independently returned native Session ID
`01a05528-09c2-73c2-9feb-a212024d0a2c` and its Session file location. Product implementation may
store the Session ID plus entry ID as provenance, but must not parse that file for LifeModel input.

## U1 — bounded, removable context use

The isolated Pi process loaded
`research/2026-08-31/d2-pi-lifemodel-gate-extension.ts` with the official `--extension` option. A
base64url payload containing one approved preference was staged through an Extension command. The
official `before_agent_start` hook appended the bounded block to `event.systemPrompt` for that turn
only.

When asked only for the preferred codename, Pi returned `U1-ALPHA`. The actual user message events
contained only the user's prompt; the Extension command and bounded context were not presented as
user-authored evidence.

The Extension clears its pending payload before each use. After `new_session`, the same information
question returned `UNKNOWN`, proving the context was not persisted into later turns or the new
Session.

## Product constraints derived from the gate

- Establish a Farfold-owned leaf cursor from a baseline official `get_entries` response, then
  capture only later entries after `agent_settled`; never scan old Sessions in the background.
- Use the official `get_entries` response as C1 evidence and keep native Session ID and entry ID
  together.
- Use a one-shot `systemPrompt` augmentation for U1; do not persist a custom Pi message.
- Show the exact bounded item set before staging it, clear it after one send, and record the
  resulting Injection Manifest separately from the Pi Session.
- Treat the injected block as user-approved context only, never as tool authority or instructions.
- If LifeModel storage, preparation, or Extension staging fails, report that injection was skipped
  while leaving the ordinary Pi prompt path usable.
