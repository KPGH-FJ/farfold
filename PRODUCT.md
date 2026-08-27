# Farfold Product Contract

## Purpose

Farfold is a general personal desktop Agent that can handle knowledge work and coding through
one trustworthy runtime. Users choose a real Project folder, Provider, and model, then work in a
continuous Pi Session through a native macOS interface.

## Runtime Ownership

Pi owns the Agent loop and all Agent semantics. Farfold owns the desktop lifecycle, native
interaction, clear presentation, and future product-specific integrations.

```text
React UI
  -> typed Tauri commands
  -> Rust Pi process owner
  -> pinned Pi RPC sidecar
  -> Provider, Session, Project resources, tools, Skills, Extensions
```

## Gate 0 Product Surface

- New and resumed sessions
- Streaming user and Agent messages
- Provider and model selection using Pi-native capabilities
- Project folder selection and Pi-native project resources
- Tool activity, stop, steering, and recoverable errors
- A restrained Chinese desktop UI; technical Provider, model, and tool names remain unchanged

## Deferred

- LifeModel and LifeModel Proposal
- Windows and Linux
- External release, billing, collaboration, sync, and cloud accounts
- OpenLife migration or compatibility

## Product Truth

Gate 0 is complete only when every scenario in `plans/gate-0.md` passes in the formal macOS
application with a real Provider. Tests and development shells support the claim but cannot
replace it.
