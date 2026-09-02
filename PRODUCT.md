# Farfold Product Contract

Approved: 2026-08-31

Current implementation truth: the shipped application remains Pi-only until later phases pass
installed-app acceptance.

## Purpose

Farfold is a general personal desktop Agent product with one coherent Farfold UI/UX. A user chooses
a real Project and a supported Agent Runtime, sends work through Farfold, follows the Runtime's real
progress and controls, and returns to the Runtime's native Session later.

Farfold is not a launcher for third-party UIs. Runtime identity and special capabilities are visible
inside Farfold's own interface, while the backend Runtime continues to own Agent behavior.

## Ownership Boundary

```text
Farfold React UI
  -> typed Tauri host contract
  -> Runtime-specific Adapter
  -> official external Runtime surface
  -> Runtime-native Agent loop, Session, Provider/model, tools and memory
```

Farfold owns:

- desktop lifecycle, Project selection, navigation, presentation, accessibility, and recovery;
- Runtime discovery, installation/connection references, capability snapshots, and Session binding;
- a loss-aware projection of Runtime events into Farfold UI;
- user-owned LifeModel storage, Proposal review, provenance, and injection manifests.

Each Runtime owns:

- Agent planning and loop semantics;
- Provider/model authentication and invocation;
- native Session history and working memory;
- tools, permissions, Skills, Extensions, compaction, steering, abort, and resume;
- Runtime-specific features that Farfold exposes only when the Adapter verifies them.

Farfold must not fork or patch a Runtime, implement a replacement Agent loop, reinterpret Agent
intent, or claim unsupported features through a lowest-common-denominator abstraction.

## Runtime and Session Contract

- Pi is the incumbent reference Runtime. Existing Pi behavior and UI/UX remain the regression bar.
- OpenCode is the first approved non-Pi Adapter target, using its official HTTP/SSE Server surface.
- Future Runtimes enter through the same evidence gate but may use different official protocols.
- A new Farfold Session binds to one Runtime product, one installation/connection, one Project, and
  one native Session identifier. The binding is immutable for that Session.
- Selecting another Runtime starts or opens another Session; Farfold does not copy opaque Session
  state between Runtimes.
- Provider/model readiness belongs to the selected Runtime connection. A model catalog entry does
  not prove credentials, quota, or live availability.
- Unknown Runtime events remain available as raw Adapter envelopes and degrade to an honest generic
  presentation rather than being silently dropped.

The UI exposes three independent capability states:

1. **Base Runtime** — conversation, events, tools, completion, cancellation, and native continuity;
2. **Contributes to LifeModel** — verified durable user-message source at C1 or C2;
3. **Uses LifeModel** — verified official context-injection channel at U1 or U2.

## LifeModel Contract

LifeModel is optional long-term user understanding shared across eligible Runtimes. It is not an
Agent's working memory and it must not be required for ordinary Base Runtime work.

```text
Runtime native history
  -> Farfold Source Envelope
  -> bounded extraction and redaction
  -> Atomic Proposal
  -> user edit/approval
  -> Canonical LifeModel
  -> relevance selection and user preview
  -> Runtime official context channel
```

- No Runtime may write canonical LifeModel directly.
- Assistant messages, tool output, secrets, third-party facts, and temporary task parameters do not
  become user facts by default.
- Proposal approval governs only canonical LifeModel entry; it never grants tool authority.
- Canonical items are Runtime-independent. Provenance records the source installation, connection,
  native Session, source message, and extraction/injection history without making a Runtime owner.
- Consumption is explicit and inspectable. The user can preview/remove the selected context, and
  Farfold records what was injected through which official Runtime channel.
- A Runtime that fails C1 cannot contribute; a Runtime that fails U1 cannot consume. Base capability
  may remain available independently.

## Product Surface by Phase

### Current shipped truth

- Pi-native new/resumed Sessions, Provider/model selection, Projects and resources;
- streaming messages, tools, Stop, steering, follow-up, recovery, and restart continuity;
- formal macOS installed-app evidence preserved in `plans/gate-0.md`.

### Approved next sequence

1. Thin Runtime-neutral host seam with Pi as the only Adapter and no user-visible regression.
2. Minimal LifeModel vertical slice after Pi itself passes C1/U1.
3. OpenCode Base Adapter with explicit Runtime identity and capability-specific UI.
4. OpenCode contribution/consumption and a real cross-Runtime LifeModel loop.

The sequence does not authorize all phases at once. Each phase advances only after its acceptance
conditions in `plans/runtime-neutral-lifemodel.md` pass.

## Non-goals

- embedding Codex, OpenCode, Kimi, Pi, or another Runtime's own UI;
- changing or patching backend Runtime source to fit Farfold;
- one universal `runtime_id` that hides installation, connection, Session, or provenance identity;
- switching a live native Session between Runtimes;
- a Farfold-owned Agent loop, custom universal permission engine, or invented Task/Run/Item model;
- automatic canonical LifeModel writes or using Proposal review for normal Agent tool permissions;
- OpenLife migration, schema reuse, source dependency, or compatibility;
- Windows, Linux, cloud sync, collaboration, billing, or external release in the current plan.

## Product Truth

Source code, unit tests, browser demos, and standalone Runtime PoCs are supporting evidence only.
A Runtime or LifeModel phase is product-available only when the same build passes its acceptance
journey in the installed and signed macOS Farfold application with a real Provider. Until then, the
UI and release notes must state the narrower current capability.
