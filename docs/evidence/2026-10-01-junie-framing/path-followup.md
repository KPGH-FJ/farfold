# 启动路径差异：通用受管目录下一片

2026-10-01，独立只读复核；未再运行 Agent、未解压新副本。此次归档检查完成后已[精确清理](owned-download-cleanup.json)。

归档中的 `junie.cfg` 声明 `app.classpath=$APPDIR/junie-release-3419.24.jar`，`.jpackage.xml` 标识 jpackage 21.0.8。固定版本 [AppLauncher.cpp](https://raw.githubusercontent.com/openjdk/jdk21u/jdk-21.0.8%2B9/src/jdk.jpackage/share/native/applauncher/AppLauncher.cpp) 111–116 展开应用位置，[JvmLauncher.cpp](https://raw.githubusercontent.com/openjdk/jdk21u/jdk-21.0.8%2B9/src/jdk.jpackage/share/native/applauncher/JvmLauncher.cpp) 66–70 将结果作为 classpath 参数。[URLClassPath.java](https://raw.githubusercontent.com/openjdk/jdk21u/jdk-21.0.8%2B9/src/java.base/share/classes/jdk/internal/loader/URLClassPath.java) 170–185 使用平台路径分隔符拆分；[Java 21 官方命令说明](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html#standard-options-for-java)说明 macOS 的 classpath 分隔符为冒号。

当前 `prepare_from_registry` 使用 `data/agents/<agent_id>/install-*`，目录条目的 ID 为 `registry:junie`。因此 Farfold 自己生成的路径包含 classpath 分隔符，存在可由以上源码链证明的启动路径缺口。独立探针路径没有该冒号。空格并非已证实原因：Farfold 与 launcher 使用参数数组，当前没有 shell 拆词证据。

这仍不等于原两次 parse_error 已被唯一归因：旧输出字节没有保存，独立探针也没有使用正式 SDK。下一片用通用路径修正与实际安装验证判定，不修改解析器或外部 Agent。

## 最小实施范围

1. 新普通候选改用独立目录命名空间，例如 `data/agent-installations/agent-<编码 ID>/install-*`。复用 `managed_programs.rs` 的百分号字节编码与逐层非链接核验，不能将编码 ID 混入旧 raw ID 根目录而引入碰撞。伴随程序目录保持原语义。
2. 既有安装仍按原 command/args/env 与收据工作，不迁移、不改原选择。`installations::owned_root` 同时核验新旧精确父目录；`program_only` 保持伴随程序的现有约束。失败、取消和回收未确认继续保留旧目标。
3. 同步三个已存在的安装来源核验消费者：`auth_route::managed_kilo`、`auth_route/copilot::verify`、`preparation_actions` 的收据证明；仅复用根目录判断，保留各自清单、唯一收据、参数及版本条件。覆盖编码碰撞/逃逸、父目录和根链接、旧新管理、三类来源证明及失败保旧目标。

本片仅移除 Farfold 自己加入的分隔符，不承诺用户提供的任意外部路径都适合任何程序。分组记录保护片验收后，再实施本片并从正式应用执行 Junie 安装；登录、模型请求和续接各自保留判定。
