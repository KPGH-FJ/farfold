# Windows MCP 与共用前端定向结果

固定源 `b7147e530742c47b96713495dea8b736dc9ec630`，唯一运行 [41942738310](https://github.com/KPGH-FJ/farfold/actions/runs/41942738310)，唯一派发及 watch 自然退出0。本记录保留已封存 [原件 ZIP](originals.zip)，31成员的内容、SHA与CRC均与各自原件核合；现已由root阅读全文、摘要及封包清单，并核31成员与嵌套22/17成员的CRC、大小/SHA和文字类型。

实际结果：四份 PowerShell ParseFile 无错误；单次 lib 测试编译和既有 helper 编译成功；实际 list18 与逐名执行18pass/0fail/0ignored/natural0；共用前端3文件15项与typecheck均自然0。List/Frontend/All三份原回执及实际最终聚合的 source、selection、input map、binary/helper SHA 全部核合，不靠 continue-on-error 步骤颜色。

2307项输入 before/after 相同，固定 Git 源比对为35项原字节、2272项仅LF→Windows CRLF。18项库测试用时9.01秒；完整job14分41秒，编译步骤12分29秒。22成员原artifact ZIP与API digest一致，17成员原workflow日志ZIP CRC通过。包只含JSON/日志等文字原件和原ZIP，不含exe/dll/helper实体；远端二进制只能记实际CI计算并跨阶段核合的SHA，不能说本机独立重hash了远端exe。

前端15项由MCP wire9、审阅组件3、P01队列schema3组成。Windows前端实际回放已提交的 **Mac三份DTO fixture**，跑SSR/controller与mock settings队列测试；本次后端生成的 **10条Windows DTO**（3精确、4不可信generic、3重复来源generic）没有经过该前端用例、完整IPC或安装版界面。这两个范围分别成立。两条Unix专属测试没有在Windows编译/执行；不计作ignored或通过。

这不是实际官方CLI/Agent/账号/模型、用户配置采用、MCP连接/工具调用、Windows DOM、安装版、Windows SQLite FULL、完整P01/Windows验收。只覆盖固定b714，**不涵盖后来的ea6 Vite调整**。原封包只汇总已有原件；独审范围是原run与原始工件，新外包机械核验另行记录。

真实独立reader `environment_review` 的结论为 `PASS_WITH_EXPLICIT_SCOPE`，0必改，原字节已纳入ZIP。reader SHA256：`2d8294fde4a1a782557b66009f8c1241b6650dde53a93e981e55504bd24ced64`。其范围是原run与原始工件、全部绑定明细及有限支持源抽核；没有重跑2307 Git核验、没有本地重hash远端exe，也没有冒称已独审新外层ZIP。新ZIP的CRC/逐成员原字节检核由封包者完成，见 [清单](manifest.json)。

[原封包清单](sealed-manifest.json)保留准备稿三件的原哈希；[当前公开包装清单](manifest.json)另记本页/摘要发布补记后的哈希，31成员原件ZIP保持原字节。原清单的待发布状态是封包时观察，不是当前执行安排。
