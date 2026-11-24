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

## 正式应用回执

只选已授权、归属明确的样本。先定义要观察的实际行为。Agent 用正常界面操作，在操作后读回结果。正式安装或 Agent 版本无法核对时先保留缺口。昼夜时间由工具记录 UTC，操作说明可用当地时间。

在 macOS 正式 Farfold 运行时，以下入口从实际安装读取版本、可执行文件摘要、签名身份、进程和平台。可选的 Codex 对话摘要须来自已核实的自有样本。它仅定位一条官方记录，并输出版本和证据摘要。

```sh
node scripts/observe-installed-app.mjs [owned-Codex-thread-SHA256]
node scripts/record-installed-case.mjs begin output/owned-run /path/to/case.json
# 通过真实界面操作并读回。将观察时间和已核对的布尔值写入 ui.json。
node scripts/record-installed-case.mjs finish output/owned-run /path/to/ui.json
corepack pnpm acceptance:check output/owned-run/receipt.json
```

案例用 `agentId`、`caseId`、`binarySha256`、`productCommit`、`conditions` 和 `observations`。`conditions` 的元素形如 `{ "id": "P01", "excerpt": "不自动发送" }`，其正文从原条件读取。`observations` 是命名布尔值，例如 `{ "send-disabled": true }`。`threadSha256` 可选。未指定时，从实际 Agent 取 `observedAgentVersion` 并填入案例。`productCommit` 填安装候选的来源，无法核清时如实标记。计划复用时显式设 `reviewBy`。

`ui.json` 只包含 `startedAt`、`finishedAt` 和相同字段名的 `observations`，时间取实际读回窗口的 ISO UTC 毫秒值。原始观察私有保存，公开摘要只保留范围与结果。此工具记录 Agent 从界面读回的观察，并校验运行前后的输入身份；独审仍需查原始观察和因果边界。Codex 当前分项示例见[正式版试点](evidence/2026-11-24-development-delivery/README.md)。

### 何时补验

- PR 的基线或候选提交变化时，重新核对变更对原意见和检查的影响，独审结论明确绑定新基线与新候选。PR 检查使用实际合并预览。
- 应用、Agent 程序、服务和配置、系统、样本或检查定义变化时，核对相关回执依赖。以新采集的 `currentInputs` 和 `changes` 写入变更文件，运行 `corepack pnpm acceptance:revalidate <receipt.json> <changes.json>`。逐案读取 `action` 和 `reasons`。
- `revalidate` 表示补验。`reuse-candidate` 表示可交独审判断复用；确认原件、作用范围和当前条件后再使用。命令执行成功只表示复验规划已生成。原失败、结果未知、证据不可复核或新的不确定性继续留证。

## 独立复核和合入

在同一候选差异上独立检查实现、保护规则、测试和原始操作证据。记录审查人、基线与候选完整 SHA、发现以及修正后结论。在 PR 中给出任务 ID、改动作用、工程检查、实测范围和余项。保护规则、验收强度和工作流规则变动须由审查人明确核对。

GitHub Actions 验证合并预览的两个父提交，按触达范围产生 `Farfold delivery check`。主线推送后的检查使用推送前的提交作为基线。若浅克隆缺少推送前基线，工作流会报错，需对完整推送范围检查。

```sh
node scripts/delivery-pr.mjs <PR-number> /path/to/delivery-record.json
gh pr merge <PR-number> --merge --match-head-commit <reviewed-head-SHA>
```

交付记录顶层为 `base`、`head`、`review`、`stable`、`installed`。`review` 包含同样的 `base`、`head`、独立 `reviewer`、`verdict` 和 `summary`。完成独审后填写 `approved`。`stable` 和 `installed` 各写 `required` 与 `reason`，适用的七项回执提供 `stable.report` 与 `stable.sha256`。`installed.receipts` 是 `{ path, sha256, productCommit, binarySha256, requirementIds }` 列表。无相关证据时使用空列表。合入命令中的 `head` 必须对应刚核对的 PR。合入后用实际主线结果核对交付。

当前仓库的服务器端主线保护须由仓库套餐启用。保护启用前，合入者执行以上核验，检查通过和独审记录可用于放行。`--match-head-commit` 保护候选头变化。若主线同时推进，重新确认基线和合并结果。

## 交付耗时和返工

保留开工、可验收、独审、合入时间，区分实际检查与外部等待。独审首次结果和返修轮数来自实际审查回执。记录需要用户补充、配合点击或排障的次数与时间。工程回执记录检查耗时与起止磁盘余量，Actions 回执记录检查运行时间。缺少 Token、付费、资源峰值或人工分钟的实测时记未知。多次同类任务完成后再比较交付质量和用时。
