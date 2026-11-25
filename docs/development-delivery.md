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

Windows 工程检查先构建进程测试夹具，再运行精确选择的工作树用例。前置检查已有失败时，工作流保存具体失败和定向测试结果，本次直接拒绝。清除前置失败后，仍须完整 Windows 套件通过才能交付。

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

GitHub 在 `main` 上执行 PR 与工程检查规则。工程工作流验证合并预览的两个父提交，按范围产生 `Farfold delivery check`。最终核验工作流从受保护的 `main` 读取核验代码，在工程工作流之后评估同一基线、候选、合并预览和工程报告。它把同一次判断发布到合并预览和候选提交，候选提交的检查最后通过，供 GitHub 合入规则识别。当前生效的必需检查以 [GitHub 主线规则](https://github.com/KPGH-FJ/farfold/rules?ref=main) 为准。

当前个人仓库的规则按检查名称和 GitHub App 身份识别发布者。同一仓库的普通工作流共用 GitHub Actions App 身份。专用发布工作流在 `farfold-final-publisher` Environment 取得安装令牌。`GITHUB_TOKEN` 仅用于读取验证数据。写入候选和预览后分别核对返回的数字 App ID、提交和状态。没有唯一关联 PR 的事件不发布检查。独立发布和适用私有证据的真实放行链路验证通过后，才将最终检查设为永久必需。

### 一次性配置和治理过渡

从 [GitHub Apps](https://github.com/settings/apps) 核对现有身份。需要新建时，App 仅在仓库所有者账号下可安装，主页用 [Farfold 仓库](https://github.com/KPGH-FJ/farfold)，关闭 webhook。仓库权限先配置 `Checks: Read and write` 及自动授予的 `Metadata: Read`。安装时选 `Only select repositories`，只选择 `farfold`。验证 ruleset 能绑定真实检查的数字 App ID。若 GitHub 实际要求其他权限，先记录平台拒绝及所需权限。

在 [发布 Environment 设置](https://github.com/KPGH-FJ/farfold/settings/environments) 选 `Selected branches and tags`，保留唯一 `Branch: main`，核验没有 Tag 或 PR 引用。Environment 变量 `FARFOLD_FINAL_PUBLISHER_CLIENT_ID` 用 App Client ID，`FARFOLD_FINAL_PUBLISHER_APP_ID` 用数字 App ID。将 App 的 PEM 私钥放入同一 Environment 的 `FARFOLD_FINAL_PUBLISHER_PRIVATE_KEY` secret。工作流只在 `main` 检出受信提交，以单仓库、`checks: write` 权限生成短期安装令牌。发布任务不执行候选提供的代码、不安装候选依赖、不恢复候选缓存。

过渡 PR 保留现有 PR、严格基线及工程检查规则。这一阶段 GitHub 的合入按钮可能在旧终检失败时仍可用。交付人须等独立保管方签署当前候选的 `schemaVersion: 1` 治理记录，再从旧 `main` 发起终检，核对本次运行确实验证了签名，并在候选和合并预览上都发布成功。缺少本次通过结果、输入有变化或无法读回时停止合入。满足条件后按下方带候选 SHA 的命令正常合入。

过渡合入后，先验证专用 App 实际发布、普通 PR 无法访问发布 Environment，以及同一真实产品候选的完整证据能通过、缺失或撤回证据能被终检拒绝。撤回验证须从已有专用 App 成功状态开始，并读回该候选和合并预览的新结果。若刷新失败或仅剩旧绿勾，停止合入和永久启用，先核清旧状态为何仍可用于合入。用上述结果确认生效规则能绑定专用 App 后，将终检加入现有 `main` ruleset，保留工程检查、严格基线和 PR 规则。在规则生效时核验 GitHub 确实阻止拒绝案例，完成合格产品 PR 的正常合入，再读回规则。

`Farfold final delivery` 从 GitHub API 核验 Codex App 发布的独立代码审查。原始 App、机器人和最近编辑者身份均要匹配。审查须完成、无报告发现、对应当前候选，并在当前合并预览和工程运行启动后完成。候选须包含当前基线，候选与合并预览的源码树须相同。App 评论格式变化、空结果和旧结果都会拒绝放行。App 审查原始文件的范围是 GitHub 可访问的材料，私有实机原件由独立任务在受限环境复核。

```sh
node scripts/delivery-pr.mjs <PR-number> /path/to/delivery-record.json
```

本地交付记录顶层为 `base`、`head`、`review`、`stable`、`installed`。`review` 包含同样的 `base`、`head`、独立审查人、结论和摘要；接受既有回执时还须填 `review.revalidations`，逐项绑定 `receiptSha256` 与 `revalidationSha256`。适用的七项回执提供 `stable.report` 与 `stable.sha256`。安装回执项使用 `{ path, sha256, productCommit, binarySha256, requirementIds, mode, build }`，`build` 为构建记录的 `{ path, sha256 }`。复用额外提供 `revalidation: { path, sha256 }`。无适用证据时使用空列表。

独立复核任务通过受限交接取得原件，读回行为结果，核对安装与构建来源、原条件、证据完整性及复验报告。适用平台的构建报告和安装回执须对应同一候选源码树及已验证二进制。Windows 工程测试和安装程序生命周期检查分别记录其实际范围，Windows 正式应用操作须有相应原始观察。

适用实机或治理复核时，受信保管方用隔离的 Ed25519 密钥签署独立执行的最小公开摘要，GitHub Actions 只持有 `FARFOLD_PRIVATE_EVIDENCE_PUBLIC_KEY` 公钥。签名涵盖实际审查执行编号、记录摘要、原件交接编号、PR 和版本、工程运行及尝试编号、适用回执和规则影响。署名前查阅原件并核对 `delivery-pr.mjs` 的结果。治理变更须附上规则怎样保留原验收要求的具体依据。签名格式以 `scripts/delivery-private-attestation.mjs` 为准。原件、会话正文、账号信息、机器路径和密钥留在受限环境。缺少受信记录时，适用的最终核验会拒绝。

专用 App 路线使用 `schemaVersion: 2`。所有者先为该 PR 发布唯一的占位评论，首行用 `<!-- farfold-private-delivery:v1 -->`。签发方把 GitHub 返回的评论数字 ID 写进 `claim.witnessId`，用 `privateAttestationBytes(claim, 2)` 签署。所有者只编辑这条评论一次，保留首行并将正文替换为已签名的 JSON。终检一致核对 GitHub 两个接口的正文、作者和编辑历史。撤回时删除该评论。更换原件、审查或签发结论时，撤回旧评论，再创建新评论，由签发方重新签署该新 ID。复制旧信封或再次编辑已发布的摘要均被拒绝。

本机复核身份可用一次性系统授权配置为专用标准用户或受管服务。由管理员保护签发入口和密钥目录，开发身份仅提交请求和只读原件副本。给独立 Agent 提供这一候选的精确源码、原验收条件、封存回执及工程报告。签发方从其实际完成的执行记录取得编号、结束时间和原始记录摘要，核对结论后在隔离环境签署。仓库变量只接收该签发方的公开 Ed25519 SPKI 公钥。现有共享系统用户可做只读独审，同一用户生成的密钥无法提供独立保管。

```sh
gh workflow run delivery-final.yml --ref main -f pr_number=<PR-number>
gh run watch <returned-run-id> --exit-status
gh run view <returned-run-id> --log
gh pr merge <PR-number> --merge --match-head-commit <reviewed-head-SHA>
```

终检在工程尝试完成或重跑启动、Codex 的有效代码审查变化、保管方摘要变化或手动刷新时运行。普通评论与首次工程检查启动不触发完整核验。Codex 只更新展示内容时，路由任务先用只读权限核对来源和完整编辑历史，核对通过才跳过。核验任务按 PR 串行读取当前输入。工程重跑启动事件即使先于工程查询更新，也不会复用同一运行的旧尝试。

日志中的 `waiting-engineering` 和 `waiting-review` 表示等待，对应的专用检查保持进行中。`missing-configuration` 表示发布身份或复核公钥配置缺失。`evidence-rejected` 表示适用的签署证据缺失、过期或核验不合格。`not-run` 表示本事件没有执行交付核验。只有 `verified` 对应专用 App 发布的成功结果。发布凭据缺失时，工作流无法更新已有的 App 检查。

基线推进后更新候选，再获取对应工程结果和审查。证据到期时补验，再提交对应摘要。GitHub 会缓存上一轮状态，到期本身不会启动工作流。每次合入前按上面的入口刷新，等待此次运行结束并确认 `decision: verified`。核对 PR、基线、候选、合并预览、工程尝试、证据期限及专用 App ID，再读回本次运行在两处提交发布的成功记录。各项吻合后，执行带候选 SHA 的正常合入并核对 `main`。

2026-11-24，仓库所有者在原研发交付会话中明确授权把该 GitHub 仓库设为公开，原会话保留执行及无登录访问核验。该授权范围为仓库可见性。

## 交付耗时和返工

保留开工、可验收、独审、合入时间，区分实际检查与外部等待。独审首次结果和返修轮数来自实际审查回执。记录需要用户补充、配合点击或排障的次数与时间。工程回执记录检查耗时与起止磁盘余量，Actions 回执记录检查运行时间。缺少 Token、付费、资源峰值或人工分钟的实测时记未知。多次同类任务完成后再比较交付质量和用时。
