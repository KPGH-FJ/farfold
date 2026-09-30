# 二进制安装包 `.tar.bz2` 支持

核对日期：2026-09-30。开发基线：`a0a55af2d1520be6bb334d674d432d9f959fcac9` 加当前工作区改动。这里记录源码与受控夹具验证；尚未下载/运行 Goose、操作正式应用或完成安装版旅程。

## 官方依据

- [ACP 官方目录 Goose 条目](https://github.com/agentclientprotocol/registry/blob/main/goose/agent.json)：当前条目版本 `1.52.0`，macOS arm64 归档为 `goose-aarch64-apple-darwin.tar.bz2`，执行文件 `./goose`，参数 `acp`；条目提供归档 SHA-256。此版本是观察到的目录数据，实现没有写死版本或品牌。
- [Goose 官方安装脚本](https://raw.githubusercontent.com/block/goose/main/download_cli.sh)：macOS 分支选择 `.tar.bz2`，使用 bzip2 格式解包。Farfold 只据此核实发行格式，没有执行脚本的配置、移动程序或修改 shell 配置动作。
- 目录值与前片保留的 [registry-snapshot.json](../../2026-09-30-agent-access-first-slice/registry-snapshot.json) 中 Goose 条目一致。

## 改动与边界

通用解包代码移到 `src-tauri/src/agent_install/archive.rs`。新增 `.tar.bz2` 分支在当前候选目录内创建独占临时目录，通过 macOS `/usr/bin/bzip2` 仅解码为 tar，然后复用现有 `tar::Archive` 的目的路径检查。解码完成、失败或取消后，RAII 清理此次临时文件。

bzip2 与既有 zip 解包使用 `Job::run` 管理子进程的取消、超时、进程组结束与等待回收。tar 读取逐次检查同一个 Job；安装器保留归档校验、执行文件范围检查、候选检查与回收，以及最后原子选用旧目标的既有顺序。没有新增依赖或 Agent 专属分支。

目录的通用二进制格式许可同步增加 `.tar.bz2`，并与解包器一致地忽略 URL 查询参数与 fragment 后再判断扩展名。`https`、执行路径声明和禁止目录覆盖 `HOME` 的既有准入保留。不支持的 `.tar.xz` 条目仍保留官方平台信息，但不宣称可安装。

## 已测与未测

- [修复前失败](bzip2-before.log)：真实 bzip2 压缩的受控 tar 夹具被旧 gzip 路径拒绝。
- [解包测试](archive-tests.log)：8 项通过，覆盖 bzip2 相对执行路径、gzip/tgz/无扩展名与 URL 参数回归、损坏包清理、父目录穿越、符号链接跳转、预先取消和 tar 读取中取消；旧 zip 临时文件保护测试继续通过。
- [安装器回归](installer-tests.log)：定向 `agent_install::` 共 14 项通过；包含以上 8 项解包用例及取消后原设置/凭据保留、自定义与本机程序登记等 6 项既有检查。
- [目录入口修复前失败](catalog-before.log)：官方 Goose 样本仍被目录格式许可拒绝，`installable` 为 false；这项证据说明仅解包器测试通过不足以代表安装入口接通。
- [目录回归](catalog-tests.log)：`agent_catalog::tests` 共 17 项通过；Goose 官方样本的卡片可安装标记、缓存保留及 `installation_entry` 的 `./goose acp` 参数连通，归档 URL/SHA 声明原样保留；支持格式附带下载参数仍可进入安装器，未知格式与平台限制继续诚实区分。
- [测试初次编译错误](initial-test-compile-error.log) 保留：测试断言误用不存在的 Result 方法，已修成 `is_ok_and` 并重跑；不作为产品失败结论。
- 未测：官方 Goose 归档下载、归档 SHA-256 实际比对、Goose 连接、账号/模型请求、正式安装版 J1/J6/J2。本材料不能关闭这些旅程。
