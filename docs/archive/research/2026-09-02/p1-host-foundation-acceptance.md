# P1 — Host foundation acceptance

> 2026-09-12 文档校正：本文件保留当时的研究、交接或验收记录。正文中的“当前”、Pi-only / Pi 唯一 Runtime、未采用适配器、未完成或下一步等描述仅对应原记录时点，不是当前执行指令。正式 0.1.7 已支持 Pi、OpenCode、Codex；OpenCode ACP 的 C 阶段已通过 Dev 工程出口，D Pi 仅部分实现、普通 ACP 工作台未接通，E 未开始。开发和自动续接已按用户要求暂停。最新状态以[唯一活动计划](../../plans/runtime-neutral-lifemodel.md)和[正式使用说明](../../INTERNAL-USE.md)为准；不得按旧报告重做已完成工作或清理当前用户数据。

Date: 2026-09-02

Status: source and release-build foundation passed. This is not formal installed-app product
acceptance.

## Scope

P1 establishes the durable substrate required by later Host ownership. It does not move Pi or
OpenCode lifecycle into the new Host, switch existing JSON writers, migrate a real profile, change
the product UI, or promote OpenCode/LifeModel into the formal application.

Commits:

- a857591 — transactional Host storage, typed identities, recovery startup, and single instance;
- 0f494db — bounded legacy preview, schema v2 migration, and transactional Runtime/Session records.

## Implemented foundation

### Typed identity

Distinct Rust types now represent:

- Runtime product;
- Runtime installation;
- Runtime build;
- Adapter;
- connection;
- Project;
- Working Copy;
- Farfold Session;
- native Session, Turn, item, and interaction.

IDs reject empty, whitespace-surrounded, path-like, control-bearing, and oversized values. A stable
installation slot and an observed Runtime build are separate records. The schema can retain
multiple build generations for one installation without rewriting an existing Session binding.

### SQLite authority

The new farfold-host.sqlite3 foundation uses:

- bundled SQLite through rusqlite 0.40.2;
- application ID 1178686022;
- schema version 2;
- STRICT tables, foreign keys, immutable composite identity references, and indexes;
- WAL journal mode, FULL synchronization, and a five-second busy timeout;
- transaction commit before a successful Runtime or Session registration returns.

Schema v1 defines Runtime products, installations, builds, connections, Projects, Working Copies,
Sessions, drafts, attention, and last-opened app state. Schema v2 adds a bounded legacy migration
ledger. There is intentionally no canonical transcript or native message table.

### Migration and recovery

- A non-empty database is backed up through SQLite's online backup API before migration.
- The temporary backup is integrity-checked and atomically renamed before schema changes begin.
- v0 -> v2 and v1 -> v2 are supported in one transaction.
- schema_migrations and PRAGMA user_version record each applied step.
- Reopening v2 is idempotent and creates no second migration backup.
- A database with a foreign application ID, newer schema, invalid SQLite bytes, failed integrity
  check, or failed migration enters recovery state instead of being replaced by an empty database.
- The Tauri Host initializes this state side-by-side at farfold-host.sqlite3 and exposes only
  purpose-scoped storage status and migration-preview commands.

No existing profile was opened by the new application during this acceptance run.

### Legacy boundary

The read-only preview recognizes only Farfold-owned:

- last-pi-session.json;
- opencode-session-bindings.json;
- lifemodel.json.

It rejects symlinks, non-files, files over 8 MiB, invalid JSON, unsupported versions, unsafe Pi
pointer boundaries, invalid OpenCode identity/session bindings, duplicates, and impossible
timestamps. Preview output contains path, SHA-256, count, disposition, and stable issue code only.
LifeModel values and source text are deserialized as ignored content and cannot appear in preview
serialization.

The Pi pointer preview verifies only that the selected file remains inside the Farfold Pi Session
directory. It does not parse Pi JSONL to invent a native Session identity. Both Pi and OpenCode
imports remain pending until the appropriate official Runtime surface validates the native
Session. LifeModel migration remains deferred to P8.

### Transactional registration

The Host database can idempotently register:

- one Runtime product;
- a stable installation slot;
- one or more observed builds;
- a connection;
- a Project and Working Copy;
- an immutable Farfold/native Session binding.

A conflicting ID or native Session binding fails the whole transaction. Tests prove that a failed
Session registration does not leave an orphan Project or Working Copy.

### Single process

tauri-plugin-single-instance 2.4.4 is registered before other plugins. A second process request
unminimizes, shows, and focuses the existing main window. Formal installed-app behavior remains a
P9 acceptance item; P1 proves dependency integration and release compilation only.

## Verification

- corepack pnpm format:check — passed;
- corepack pnpm typecheck — passed;
- corepack pnpm test — 66 passed;
- corepack pnpm build — passed, with the existing non-blocking large-chunk warning;
- cargo fmt --check — passed;
- cargo clippy --locked -- -D warnings — passed;
- cargo test --locked — 64 passed, including 15 Host identity/storage/migration/record tests.

A release D3 QA application was built without installation or launch:

| Field                             | Value                                                            |
| --------------------------------- | ---------------------------------------------------------------- |
| Bundle path                       | src-tauri/target/release/bundle/macos/Farfold D3 QA.app          |
| Bundle identifier                 | ai.farfold.desktop.d3qa                                          |
| Executable SHA-256                | 7166813b15c09ec493f8c980d9fe9926f664148011247016db230699919a2b7f |
| codesign --verify --deep --strict | passed                                                           |
| Notarization                      | not attempted; no claim                                          |

The build output is ignored and was not installed over /Applications/Farfold D3 QA.app.

## Acceptance map

| P1 requirement                       | Evidence                                                                         | Result                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Typed identities                     | host_ids types and validation tests                                              | Pass                                                          |
| Versioned SQLite schema              | v1/v2 migrations, application ID, STRICT/FK tests                                | Pass                                                          |
| Stable installation/build separation | runtime_installations plus runtime_builds and multi-build test                   | Pass                                                          |
| Transaction-before-success           | Runtime/Session registration and rollback tests                                  | Pass                                                          |
| Consistent migration backup          | SQLite backup, integrity check, atomic rename, v0/v1 tests                       | Pass                                                          |
| No silent empty database             | corrupt/future/foreign database recovery paths                                   | Pass                                                          |
| Native history stays Runtime-owned   | no transcript/message table; Pi JSONL is not parsed by preview                   | Pass                                                          |
| Bounded legacy path                  | known-file allowlist, size/symlink/schema checks, content-free fingerprint       | Pass                                                          |
| No long-term dual write              | no legacy writer was connected to SQLite; cutover remains an atomic P4 operation | Pass                                                          |
| Single-process foundation            | plugin first in builder and release bundle compiles/signs                        | Pass at source/build layer; installed behavior deferred to P9 |

## Decision and remaining truth

P1 passes as a foundation phase. P2 may begin.

The actual legacy binding cutover remains in P4, where SessionBindingIndex and official Adapter
validation exist. Until that cutover, the current prototype continues to own its legacy JSON
writes; the new database does not mirror them. This avoids dual-write divergence.

The formal /Applications/Farfold.app remains unchanged and Pi-only. No profile data was migrated,
deleted, or reset. No installed-app OpenCode, LifeModel, recovery-screen, or single-instance claim
is made by this report.
