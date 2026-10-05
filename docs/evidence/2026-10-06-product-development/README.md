# 连续开发检查（2026-10-06）

Windows 本片复用同一UI，补系统凭据、进程树和终端、句柄文件访问、独立WebView2、私有网页分享、系统通知及安装更新配置。交叉复核修了辅助进程入组前取消、迟到网页回调抢新请求、资源准备失败未停止、手动观察误拒与安装取消/体积限制。前端184文件/2101项、类型/构建通过，见[最终前端回执](windows-frontend-final-checks.json)；macOS Rust949项通过、4项原忽略，格式/Clippy与Windows x86_64 GNU LLVM全部目标Clippy退出0，见[最终Rust回执](windows-rust-checks.json)。

中间两次全量失败保留。第一次在断开清理报错，具体原因未知；第二次确证合成Python内2秒期限触发，不证明子shell实际运行2秒或是首次原因。停止观察竞争用两个真实Child/watch反例修正并验证；夹具去掉重复内层期限，全部原断言、真实子程序、外层10秒及精确进程组清理保留。最终相同8线程全量通过，不以调度猜测解释原失败。

官方Windows发行格式逐项核查没有tar.bz2；其暂不支持不构成这33项的已知格式阻断。新增裸EXE保存保留Registry摘要校验，和ZIP/tar.gz均不改变Agent兼容判定；新增raw/tar共14项合成临时文件测试在Mac通过，不执行EXE。[siGit官方格式](https://raw.githubusercontent.com/agentclientprotocol/registry/65ba23daddb224a376e1955f51c095d0fb1b7448/sigit/agent.json)、[下载来源](windows-install-sources.json)、[uv/Python来源](windows-uv-sources.json)。

边界：没有Windows桌面实机；交叉编译不等于Windows测试执行、MSVC安装包或平台验收。系统凭据/声音、WebView2/NTFS、真实Agent、签名和发布渠道仍待验证或配置；Windows通知点击暂限应用运行中，文件访问拒UNC/重解析目录，生产截图仍不交付。未替换正式应用，未追加真实消息预算。Windows工作流保持手动且未触发；新工作流首次注册需默认分支，远端main未因本片修改，参见[GitHub规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。

本轮已获用户开发授权，先保存依赖闭合的既有源码，再按唯一活动计划推进。工程测试与真实产品验证分开；未启动真实Agent、访问账号、调用模型或替换应用。

基线检查全部退出0：格式、类型、前端测试、构建、Rust格式/Clippy/测试。前端174文件/2000项通过；Rust823项通过、4项原忽略（真实Agent2、Keychain2）未启用。构建保留大于500kB的包体积提示。日志为本目录baseline-*.log。

[test-collection.json](test-collection.json)记录修正前后实际Vitest文件发现：调研下载中默认可收集1304个外部测试；修正后174个正式项目文件，无遗漏或多出。该发现只列文件，不执行第三方测试。前后端独立源码审查未发现可确证的新增基线阻断；源文件、新模块和新增素材须一起保存。

已有正式应用仍为0.1.7/c97e9b23候选；本轮保存源码不宣称与它等价，不修改首批33项完整达标结论。

接入共用核心：每对话进程、精确持有/断开、编号冲突与未确认交付保护；新旧模型共用确认保存；声明式账号推送与未知文案。独立挑战复核发现畸形配置被空化、未交付编号过早释放、已有冷编号覆盖风险，已补行为测试并关闭。

最终 access 检查全部退出0：前端176文件/2012项，Rust850项/4项原忽略，类型/格式/构建/Clippy通过；日志为access-*.log，Rust回执见[摘要](access-rust-checks.json)。账号纯策略和事件竞态覆盖；真实stdio合成对端覆盖独立PID/路由、模型请求与账号推送。它们不是33家真实测试。1280×720及800×650合成组件可见自查无摘要横向溢出；未替换正式应用。

未解决：跨登记别名共用账号、官方补充查询、共享磁盘影响和逐家真实证据。Factory 0.230.0现代setter缺确认、load无旧模型声明；不得在失败后回退或用resume冒充只读。fast-agent 0.10.1及0.10.42切模型清历史，无保留参数，属于外部限制。[Factory官方SDK](https://docs.factory.com/sdk/python#read-session-state)、[fast-agent固定源码](https://github.com/evalstate/fast-agent/blob/4134c98617caecf731e0eec1c9621eee0c36c3a0/src/fast_agent/commands/handlers/model.py#L515)。
