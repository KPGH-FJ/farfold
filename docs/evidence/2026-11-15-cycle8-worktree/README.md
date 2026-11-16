# 第 8 周期工作树共享提示与安全复验

2026-11-15，macOS arm64。按 `ARCH-47`、`H12`–`H15`、`H17` 核对现有行为及原条件。

- 普通新对话的位置栏原本只提示权限另行确认，工作树窗口只提示账号、Git 和依赖可能共享。两个入口缺同目录文件共享说明。补为「同一文件夹里的对话共享文件」，保留现有权限和工作树环境说明。两个实际组件渲染断言在修改前均失败，修改后受影响前端 32 文件、405 项通过。Rust `worktrees::` 168 项通过。源码增量仅两处文案与关联断言。修改前（本机 `output/2026-11-15-cycle8-worktree/worktree-sharing-hint-before.log`） · 修改后（本机 `output/2026-11-15-cycle8-worktree/worktrees-ui-test-after.log`） · Rust（本机 `output/2026-11-15-cycle8-worktree/worktrees-test.log`）
- 已新建一个专用 Git 仓库和同提交的已链接工作树。两边都是干净状态、未设置远端、`shared.txt` 字节相同而文件身份不同。保存了提交、分支、Git 登记、两侧文件摘要与关键 Git 元数据哈希。没有打开应用、启动 Agent 或访问既有工作树。脚本（本机 `output/2026-11-15-cycle8-worktree/prepare-owned-worktree.py`） · 准备回执（本机 `output/2026-11-15-cycle8-worktree/owned-fixture.json`）
- 已有正式分项包括新／旧分支创建、已有工作树接入后移除清单、明确使用才改变新稿位置、冷开重查。另有真实归档与原位置恢复保留暂存／未暂存／未跟踪／忽略文件、位置冲突拒绝，正式删除与独立恢复也有精确正例及原失败。当前 168 项复查覆盖受控 Git 写入、拒绝、并发、核查及恢复。真实同文件夹修改可见和不同工作树不传播，分别以第 8 周期实际会话及磁盘证据为准。[正式创建与接入](../2026-10-09-capability-hardening/worktree-task-candidate/installed-worktree-tasks.json) · [正式归档恢复](../2026-10-09-capability-hardening/worktree-recycle-candidate/installed-archive-restore.json) · [正式删除与独立恢复](../2026-10-09-capability-hardening/worktree-remove-candidate/installed-removal-initial.json)

准备环境依现有权限由 Agent 处理，Farfold 检查固定文件类型并保留所选目录上下文。账号、Git 设置、缓存、依赖和端口可能跨位置共享，接入工作树本身未验证端口或依赖就绪。本轮夹具没有启动服务、安装依赖或复制忽略文件。
