# 生产共享网页受控验证器

最终结果：2026-10-04 04:15 UTC，直接编译最终生产源码的受控流程 **17/17 通过**；主进程和 helper 均退出 0，没有强制结束，页面已移除，自有临时 socket 及其目录均已删除。编译及运行前后输入摘要一致，`-D warnings` 编译通过。

最终收据为 `results/receipt-20261004T041517Z.json`，完整回执为 `results/sharing-20261004T041517Z.json`。二进制 SHA-256：`406f329cb8701e909a95e992e7abddaddf75f497bb263d3daa0d7b62ff4f7515`。11 个生产输入、验证器源码、编译记录及最终回执已冻结到 `final-evidence/`。

旧 FD 交接候选仅编译，从未运行，不计为成功证据。普通 UDS 第一候选在机械 lint 修正前通过 16 项，保留于 `candidate-16-inputs/`；上面的 17 项属于最终字节并另补精确临时 socket 清理回执，不把前后候选拼成同一次证明。

此验证器直接编译仓库的 `browser_workspace`、`browser_sharing` 和 `acp_client/transient_mcp`。`browser_sharing.rs` 与其子目录通过只读引用符号链接定位，其他模块使用绝对 `#[path]`；没有改写生产模块或伪造 ACP 接口。链接现有缓存依赖，不安装或构建 `.app`。

执行流程只包含：

1. `transient_mcp::session_params` 生成标准 MCP 配置，在内存反序列化为官方类型，并用其中 command/args/env 启动当前验证器的早期 helper 模式。
2. 保留 `bind_route("controlled-session")` 返回的许可；读取真实 stdout 上的 initialize/tools/list；明确分享之前工具拒绝读取。
3. 内存 Tauri 主页面 invoke 生产命令，在单个临时 WK 中打开匿名 `https://example.com/`，按当前 revision 明确允许共享。
4. Witness 只修改捕获到的本次临时 example.com 页面，依次设置两个固定合成标记；工具两次实际读取应得到不同正文和同一页面 label。
5. 显式 stop 返回确认之后，后续工具调用不得返回页面正文；随后 close 确认视图移除，结束 route 并等待受控 helper 正常退出，再只核本次已知 endpoint 和父目录的 NotFound 状态；不按目录前缀扫描或删除。

没有正式应用 setup、数据库、用户目录浏览、日常浏览器 profile、账号、模型、外部 Agent 或桌面截图。没有向证据写入临时授权环境、启动参数或 MCP 配置。合成标记和匿名页面回执可保存在结果文件中。实际代表 Agent 支持、诊断行为以及登录秘密交接均不由本验证器证明；正在发送中的迟到结果竞争另有定向验证，不与本顺序场景混淆。

`build.sh` 在编译前后核对 11 个生产文件及验证器输入摘要。`run_probe.py` 再核运行前后摘要和二进制摘要，输出独立结果与收据。生产源码变化时必须重新编译，不允许沿用旧成功。

```sh
sh build.sh > results/compile.log 2>&1
python3 -B run_probe.py
```

运行流程有 55 秒内部截止时间、65 秒外层截止时间；外层超时只会结束本验证器新建的进程组，本次没有触发。只有结果文件 `pass=true`、进程退出码 0、源码摘要未变化及 helper 正常退出同时成立才可记为通过。
