# D2 minimal LifeModel installed-app acceptance

Date: 2026-08-31
Runtime: bundled Pi `0.84.3`
Installed QA app: `/Applications/Farfold D2 QA.app`
Bundle identifier: `ai.farfold.desktop.d2qa`
QA Project: `/private/tmp/farfold-d2-native.U7f3GM`

The QA identity and data directory were intentionally separate from the existing formal
`/Applications/Farfold.app`. The formal app was not replaced or stopped.

## Final build identity

- `Contents/MacOS/farfold` SHA-256:
  `bffacc3e59a42e37fcf0f9505cf2d194852b95fc6a53e54244e0da52a0691a1f`
- `Contents/Resources/farfold-runtime/lifemodel-context.ts` SHA-256:
  `7defae777dbfccfc158283a6c362ee443850d65dc549bf87fa93eae5f0fb595e`
- `codesign --verify --deep --strict` passed after installation.
- The final installed-app Pi command channel reached ready in 3.452 seconds. The composer remained
  disabled until a `get_state` response for the current Runtime generation was observed.

The same final source was then rebuilt with the formal product identity at
`src-tauri/target/release/bundle/macos/Farfold.app`. Its bundle identifier is
`ai.farfold.desktop`, its executable SHA-256 is
`ea07b12d80c621ab108d979a73a1be5a9237ddd7f5de90a7146d200b1ff66258`, and strict deep signature
verification passed. This artifact was not copied over the running `/Applications/Farfold.app`.

## Installed-app journey

### C1 source and approval boundary

1. In a new Pi Session, the user message
   `这是最终来源验收消息：D2-FINAL-SOURCE。请只回复 FINAL-SOURCE-OK。` completed with
   `FINAL-SOURCE-OK`.
2. The LifeModel source list showed the complete user-authored message from native Session
   `01a05571…`, native entry `d5262d1c`, using the official `get_entries` response.
3. Creating Proposal key `final_acceptance_code` with after-value `D2-FINAL-SOURCE` left canonical
   LifeModel empty. Only the explicit `批准并写入` action created the canonical item.
4. A separate synthetic Proposal was rejected and never appeared in canonical LifeModel.

The product Extension has no `session_start` side effect and does not create an internal user
prompt. Source cursors are established through a baseline official `get_entries` call; Extension
availability is verified from official `get_commands` output.

### U1 preview, one-shot use, and manifest

1. The canonical item was selected for the next message. The composer displayed the removable
   preview `final_acceptance_code: D2-FINAL-SOURCE` under `仅下一条消息`.
2. A new empty Pi Session received the user question
   `当前提供给你的 LifeModel 验收代号是什么？只回复代号。` and returned
   `D2-FINAL-SOURCE`.
3. The composer preview cleared after the actual prompt was sent.
4. The corresponding Injection Manifest displayed `sent`, Runtime `Pi`, and one item at
   `2026-08-31 09:34:22`.

The injected block used the bundled Extension's one-shot `before_agent_start` `systemPrompt`
augmentation. The Runtime was not modified, and the injected block was not written as a user
message.

### Delete, restart, disable, and failure isolation

- Deleting the synthetic canonical item removed it from the canonical list and all future selection.
  Its Proposal remained `approved + not_materialized`, so approval history is not confused with
  current canonical state.
- Both historical manifests retained status and item IDs but replaced provider previews with
  `[deleted LifeModel item; manifest metadata retained]`.
- After app restart, canonical item count remained zero and the approved Proposal still displayed
  `已批准 · 未写入`.
- The final build's enable switch was toggled off and back on successfully. An earlier new-Session
  disabled-path run returned `UNKNOWN`, while the final backend suite independently rejects
  injection preparation whenever LifeModel is disabled.
- With the QA `lifemodel.json` intentionally replaced by invalid JSON, the panel reported
  `LifeModel 当前不可用` and `普通 Pi 对话仍可继续使用`. A new Pi Session still returned
  `BROKEN-LM-OK`. The original QA store was restored after the test.

After final deletion and restoration, the QA store had `enabled=true`, zero canonical items, three
Proposal audit records, and two redacted sent manifests. No credential value was written to this
report, the LifeModel store, or Runtime diagnostics.

## Automated verification

All repository checks from `AGENTS.md` passed against the final source:

- Prettier format check;
- TypeScript typecheck;
- Vitest: 11 files, 49 tests;
- Vite production build;
- Rust formatting;
- Clippy with `-D warnings`;
- Rust tests: 25 passed.

Focused Rust coverage proves that canonical state changes only after approval, rejection never
materializes, configured credential patterns are refused before storage, injection is bounded and
has explicit prepared/sent/failed lifecycle, and deletion removes pending duplicates and prevents
future use.

## Capability result

The bundled Pi descriptor now reports `Base=verified`, `ContributesToLifeModel=verified`, and
`UsesLifeModel=verified`. This promotion applies only to the tested Pi product/installation/adapter
identity. OpenCode and every other Runtime remain outside D2 product implementation.
