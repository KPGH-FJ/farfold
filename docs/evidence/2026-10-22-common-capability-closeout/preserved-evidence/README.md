# 当前阶段证据保留副本

2026-10-24 在用户授权的隐私检查、分批提交和清理范围内生成。本目录用于保留本批证据，不是活动计划，也不增加产品验收结论。

从原有 `selected-stage-e616.json`、`formal-18470-installation.json` 和 `formal-18470-ui-observation.json` 出发，保留直接依据、当前 r12 七项检查和 e616 受影响检查，并限量补齐一层报告依赖。Windows 原始材料保留三组：最新运行 `39958119731` 的 178 份、已知间歇失败运行 `39945651058` 的 139 份，以及此前 140 项与独立 27 项依据运行 `39948790029` 的 900 份。三组都逐文件核对原下载回执；不是重新运行测试。

`catalog.json` 同时记录原件 SHA-256、发布副本 SHA-256、字节数和转换方式。正文中的 `evidence:<id>` 在该目录中按 `entries[].id` 解析；`publishedPath` 指向可入库副本，`local-retained` 明确表示原件仍只在本地。旧报告引用的三个已修订 reader 版本另保留精确历史原件对应副本，不把当前脚本冒作旧执行输入。

副本移除了本机主目录、临时目录、Windows 用户路径、邮件地址和凭据模式，省略私人进程或界面上下文及会话标识。JSON 格式化和隐私转换会改变字节，不能拿正文旧 `sha256` 核对转换后的副本；旧值对应原件，副本值见 `publishedSha256`。

完整数据清单、数据库及 WAL/SHM、安装界面截图、辅助功能文本、私人进程参数和二进制归档保持本地，不复制其内容入库。更深历史及部分研究依据也只在索引标明本地保留；本目录没有搬入全部底层证据。隐私检查和转换记录见 [stage-privacy-and-integrity.json](../../../maintenance/2026-10-24-evidence-preservation/stage-privacy-and-integrity.json)，生成逻辑见 [preserve-stage-evidence.py](../../../maintenance/2026-10-24-evidence-preservation/preserve-stage-evidence.py)。

已知失败、默认权限下失败与另行授权子进程通过的区别、旧 304 项未全通过、安装后数据变化、误点只读核验以及未知写入者未解决等边界均保留。这里没有重新证明真实消息、多 Agent 长期负载、Windows 完整产品、29 家八项标准，或原间歇进程问题的根因消失。
