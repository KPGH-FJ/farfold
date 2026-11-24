# Farfold 研发交付

## 接手任务

从[唯一活动计划](../plans/agent-access.md)选定本批结果，在[当前状态](status.md)确认已通过范围、已知问题和依赖。用原 ID 读取具体条件和证据链接。例如第 12 周期 Codex：

```sh
corepack pnpm docs:task P01 ARCH-08 NEW-24 --package B,C,K
corepack pnpm acceptance:index --agent codex-acp --requirement NEW-24
```

当前 Codex 路径的源码入口随任务输出。其他路径按[架构说明](architecture.md)定位。打开链接核对原件。索引中的历史记录和未收录状态分别以当时材料、当前状态及正式回执解释。接手前查看 `git status`、当前提交和正式版本，核对已有工作归属。只交付本批路径。

## 工程检查

小增量按实现影响执行对应检查。对已提交且干净的候选，可直接生成工程回执。输出使用工作区外或已忽略的路径，文件名须尚未占用。

```sh
node scripts/delivery-check.mjs affected /tmp/farfold-affected.json <base-SHA>
node scripts/delivery-check.mjs stable /tmp/farfold-stable.json
```

`affected` 校验差异、变更文件格式和任务文档，执行配套工具测试。前端或原生代码有变化时运行相应套件。`stable` 运行 [AGENTS.md](../AGENTS.md) 约定的七项，适用于稳定功能批，记录提交、执行平台、每项退出状态与耗时。工作区有其他批次时直接运行本批受影响检查，通过 PR 的干净环境校验提交。等待适用平台、设备或外部条件时记录范围。

交付按实际合并预览相对基线的路径判断适用范围。影响 macOS 产品的源码、打包输入和 `public/` 静态资源要求七项稳定检查及 macOS 安装回执。经模块声明确认的 Windows 专属实现要求匹配的 Windows 工程结果及 Windows 安装回执。纯测试修改保留适用工程检查和独立复核。例如 `worktrees/tests.rs` 由 `cfg(test)` 声明，两平台要跑相应工程检查，无需重装 macOS。共用和混合修改按各路径的实际影响合并要求。新旧文件名都参与重命名影响判断。

## 正式应用回执

只选已授权、归属明确的样本。先定义要观察的实际行为。Agent 用正常界面操作，在操作后读回结果。正式安装或 Agent 版本无法核对时先保留缺口。昼夜时间由工具记录 UTC，操作说明可用当地时间。

在 macOS 正式 Farfold 运行时，以下入口从实际安装读取版本、可执行文件摘要、签名身份、进程和平台。可选的 Codex 对话摘要须来自已核实的自有样本。它仅定位一条官方记录，并输出版本和证据摘要。

```sh
node scripts/record-delivery-build.mjs /tmp/farfold-build.json
node scripts/observe-installed-app.mjs [owned-Codex-thread-SHA256]
node scripts/record-installed-case.mjs begin output/owned-run /path/to/case.json
# 通过真实界面操作并读回。将观察时间和已核对的布尔值写入 ui.json。
node scripts/record-installed-case.mjs finish output/owned-run /path/to/ui.json
corepack pnpm acceptance:check output/owned-run/receipt.json
```

案例用 `agentId`、`caseId`、`binarySha256`、`productCommit`、`conditions` 和 `observations`。`conditions` 的元素形如 `{ "id": "P01", "excerpt": "不自动发送" }`，其正文从原条件读取。`observations` 是命名布尔值，例如 `{ "send-disabled": true }`。`threadSha256` 可选。未指定时，从实际 Agent 取 `observedAgentVersion` 并填入案例。`productCommit` 填安装候选的来源，无法核清时如实标记。计划复用时显式设 `reviewBy`。

产品变更在干净的候选提交上运行 macOS arm64 构建记录命令。它将实际打包的可执行文件摘要、源码提交与源码树写入构建报告；按仓库安装约定替换唯一正式应用，再采集安装摘要。构建报告与安装回执的二进制摘要须一致，源码树须与 GitHub 候选一致。来源未核实的旧试点可以保留其原观察结论。

`ui.json` 只包含 `startedAt`、`finishedAt` 和相同字段名的 `observations`，时间取实际读回窗口的 ISO UTC 毫秒值。原始观察私有保存，公开摘要只保留范围与结果。此工具记录 Agent 从界面读回的观察，并校验运行前后的输入身份；独审仍需查原始观察和因果边界。Codex 当前分项示例见[正式版试点](evidence/2026-11-24-development-delivery/README.md)。

### 何时补验

- PR 的基线或候选提交变化时，重新核对变更对原意见和检查的影响，独审结论明确绑定新基线与新候选。PR 检查使用实际合并预览。
- 打开 PR 并冻结候选后，新执行的回执使用 `mode: "fresh"`，复用既有回执使用 `mode: "reuse"`。超过已声明的 `reviewBy` 时补验。新回执可以省略复用期限。
- 复用时从实际环境重新采集输入和适用依赖摘要，将其写进本次复验记录。字段为 `base`、`head`、`receiptSha256`、`capturedAt`、`currentInputs`、`currentDependencies`、`missingEvidence`、`concerns`。`currentDependencies` 逐项写 `dependencyId` 和当前 `fingerprint`。通过 `corepack pnpm acceptance:revalidate <receipt.json> <changes.json>` 单独查询时，将依赖列表传入 `changes` 字段。
- 放行工具重算每案复验结论。`revalidate` 要求补验。`reuse-candidate` 还须由本次独立复核绑定原回执和复验记录摘要。原失败、结果未知、证据不可复核或新的不确定性继续留证。

## 独立复核和合入

在 PR 中给出任务 ID、改动作用、原要求和证据摘要的定位、工程检查及余项。代码审查在独立上下文中核对当前差异、原要求和测试。可提交 `@codex review` 请求现有 Codex GitHub App 复审。在受限环境处理实机原件和规则变更的独立任务，记录实际执行编号、基线与候选完整 SHA、所读材料、发现及修正后结论。

GitHub 在 `main` 上执行 PR 与工程检查规则。工程工作流验证合并预览的两个父提交，按范围产生 `Farfold delivery check`。最终核验工作流从受保护的 `main` 读取核验代码，在工程工作流之后评估同一基线、候选、合并预览和工程报告。当前生效的必需检查以 [GitHub 主线规则](https://github.com/KPGH-FJ/farfold/rules?ref=main) 为准。

`Farfold final delivery` 从 GitHub API 核验 Codex App 发布的独立代码审查。App 和机器人身份均要匹配。审查须完成、无报告发现、对应当前候选，并在当前合并预览和工程运行启动后完成。候选须包含当前基线，候选与合并预览的源码树须相同。App 评论格式变化、空结果和旧结果都会拒绝放行。App 审查原始文件的范围是 GitHub 可访问的材料，私有实机原件由独立任务在受限环境复核。

```sh
node scripts/delivery-pr.mjs <PR-number> /path/to/delivery-record.json
```

本地交付记录顶层为 `base`、`head`、`review`、`stable`、`installed`。`review` 包含同样的 `base`、`head`、独立审查人、结论和摘要；接受既有回执时还须填 `review.revalidations`，逐项绑定 `receiptSha256` 与 `revalidationSha256`。适用的七项回执提供 `stable.report` 与 `stable.sha256`。安装回执项使用 `{ path, sha256, productCommit, binarySha256, requirementIds, mode, build }`，`build` 为构建记录的 `{ path, sha256 }`。复用额外提供 `revalidation: { path, sha256 }`。无适用证据时使用空列表。

独立复核任务通过受限交接取得原件，读回行为结果，核对安装与构建来源、原条件、证据完整性及复验报告。适用平台的构建报告和安装回执须对应同一候选源码树及已验证二进制。Windows 工程测试和安装程序生命周期检查分别记录其实际范围，Windows 正式应用操作须有相应原始观察。

适用实机或治理复核时，受信保管方用隔离的 Ed25519 密钥签署独立执行的最小公开摘要，GitHub Actions 只持有 `FARFOLD_PRIVATE_EVIDENCE_PUBLIC_KEY` 公钥。签名涵盖实际审查执行编号、记录摘要、原件交接编号、PR 和版本、工程运行及尝试编号、适用回执和规则影响。署名前查阅原件并核对 `delivery-pr.mjs` 的结果。治理变更须附上规则怎样保留原验收要求的具体依据。签名格式以 `scripts/delivery-private-attestation.mjs` 为准。原件、会话正文、账号信息、机器路径和密钥留在受限环境。仓库所有者发布摘要时，评论首行用 `<!-- farfold-private-delivery:v1 -->`，其后是已签名的 JSON。当前公钥应由能独立运行复核且能保管私钥的执行环境提供；缺少受信记录时，适用的最终核验会拒绝。

```sh
gh workflow run delivery-final.yml --ref main -f pr_number=<PR-number>
gh pr merge <PR-number> --merge --match-head-commit <reviewed-head-SHA>
```

App 审查和保管方摘要的发布、编辑和删除会重跑最终核验。基线推进后更新候选，重新取得对应工程结果和审查。证据到期时补验，再提交对应摘要。GitHub 会缓存上一轮状态，时钟跨过期限本身不会启动工作流。合入前重新运行，确认当前合并预览的服务器结果和证据期限，再用匹配的候选提交合入并核对主线。

2026-11-24，仓库所有者在原研发交付会话中明确授权把该 GitHub 仓库设为公开，原会话保留执行及无登录访问核验。该授权范围为仓库可见性。

## 交付耗时和返工

保留开工、可验收、独审、合入时间，区分实际检查与外部等待。独审首次结果和返修轮数来自实际审查回执。记录需要用户补充、配合点击或排障的次数与时间。工程回执记录检查耗时与起止磁盘余量，Actions 回执记录检查运行时间。缺少 Token、付费、资源峰值或人工分钟的实测时记未知。多次同类任务完成后再比较交付质量和用时。
