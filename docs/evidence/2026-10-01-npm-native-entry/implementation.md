# npm 安装后的程序入口

本片修正官方目录 npx 安装完成后的启动载荷分类。没有运行 Factory、Grok 或其他真实 Agent，没有修改外部包、用户配置、凭据或前端；真实安装检查由根任务另行记录。

## 已核实的问题与来源

此前 [npm_install](../../../src-tauri/src/node_runtime.rs) 总是返回所选 Node 和包的 `bin`，而 [程序准备](../../../src-tauri/src/agent_install.rs) 总是组成 `node <bin> <目录参数>`。npm 的 `bin` 在官方 postinstall 后不一定仍是 JavaScript。

- `droid@0.230.0` 的官方 `install.js` 第 340–397 行将 `bin/droid` 替换为平台程序的硬链接，失败后尝试软链接；只有保留 JavaScript 包装器的分支仍需 Node。
- `@xai-official/grok@1.0.45` 的官方 `bin/postinstall.js` 第 189–207 行可在包内生成 `grok-native`，然后把 `bin/grok` 链接到它。这仅支持同类机制判断，不解释旧 Grok 失败，也不约束后续目录版本。
- 固定公开包的名称、版本、入口、脚本位置与归档来源核对见 [public-sources.json](public-sources.json)。归档 integrity 只验证本次研究材料来自官方发行，没有加入程序 SHA 或版本准入规则。两份脚本均未执行。
- Mach-O 头和通用二进制表的格式依据 Apple 的 [loader.h](https://raw.githubusercontent.com/apple-oss-distributions/cctools/main/include/mach-o/loader.h) 与 [fat.h](https://raw.githubusercontent.com/apple-oss-distributions/cctools/main/include/mach-o/fat.h)。文件格式识别不证明能运行或兼容，最终仍须实际启动和 `initialize`。

此前 Factory 安装失败没有保存 postinstall 后入口的实际载荷收据，因此不能把这项确定的源码缺陷写成历史失败的已证根因；目录参数也保持原样。

## 最小实现与保护

[普通 npm 安装](../../../src-tauri/src/node_runtime.rs) 返回明确的 `command + prefix_args`。新增 [npm_entry.rs](../../../src-tauri/src/node_runtime/npm_entry.rs) 在同次安装的 `node_modules` 中检查包、manifest 和最终入口归属，允许该树内的平台依赖软链接；目录树、manifest 或入口逃出本次安装时拒绝。最终入口必须是正规文件。

分类只作有界头读取：thin Mach-O 的执行文件类型，或最多 16 个架构的 fat 表及对应执行头；检查 slice 范围与 CPU 标识一致，头读取上限 1,036 字节。确认此格式且有执行位时直接执行入口，不再附加它自身的路径。其他入口沿用绝对所选 Node 和一个入口参数，不按扩展名或 shebang 另选解释器。格式截断、非执行类型或缺少执行权限均诚实失败。

`agent_install` 只追加已经审阅的目录参数；目录环境与旧用户环境的合并、候选握手、取消、CAS、失败清理与收据选用均沿原路径。staging 成功后 `keep()` 保留原目录，并没有迁移或重定位。新增候选测试检查启动参数、环境、原选择、收据和保留后的路径。没有新路径映射、私有 HOME、环境清空、依赖或开关。

`npm_install_named` 的伴随程序路径保持原来的 Node 调用与包目录 containment，不扩大到这项普通目录入口修复。安装工具自身的 Node/PATH/环境设置保持原实现。

## 受控验证与未完成范围

[首次红测](npm-entry-red.json)实际 7 项中 4 失败、3 通过：两种官方 postinstall 形状被交给 Node，目录外入口和非正规入口没有正确拒绝。红测前只机械引入返回结构，仍执行旧 Node 逻辑。

[首轮修复检查](npm-entry-green.json)退出 101，不能称通过：直接执行 Apple `/bin/echo` 自有副本时，一项未成功，两个进程停在 `UE`；观察与精确临时目录保留见 [夹具异常收据](system-copy-fixture-observation.json)。TERM/KILL 未确认两者结束，随后只终止该次测试父进程以释放 Cargo；没有重复执行或清理仍未确认的副本。其原因未知，不归为产品启动缺陷。

随后真实执行夹具改为由本机 clang 编译的自有极小 C 程序，输出传入参数且不创建后代；所有这类执行最多等待 10 秒，结束未确认时有限回收并保留自有文件。[更换夹具后的检查](npm-entry-owned-fixture.json)为 10 通过、1 失败；两个原程序执行反例已通过，余下失败是测试误要求选用时 `updated_at` 不变，已按现有提交语义修正，其他字段仍严格核对。

最终定向结果见 [npm-entry-final.json](npm-entry-final.json)：11 项入口/候选回归与原有两个安装工具 Node/PATH 回归均退出 0。最终文件身份见 [source-final.json](source-final.json)，5 个文件均小于 1,500 行，源码差异检查通过，Cargo 已交回根任务。[14:10 的遗留观察](system-copy-fixture-final.json)仍看到上述两个 Apple 副本保持原身份与 `UE`，文件继续保留；后续自编译夹具正常执行并被等待结束。全量工程检查和正式安装结果由根任务补充；这些受控结果不代替真实 Factory/Grok 接入、登录、首发或恢复验证。
