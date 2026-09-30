# fast-agent 0.10.1 连接失败调查

本目录记录安装候选 `85235cd` 的一次真实失败及独立、受限的包调查。正式安装应用 SHA-256 为 `fbf8723a7b06ba6004d82d6cf8292d9c3bb3ed488fa29ab6b4273b0553551fb1`。未修改产品源码、外部 Agent、账号或配置；未执行 Agent 主函数、独立握手或消息。

## 已知事实

- 正式应用中显式准备 uv/Python 成功。fast-agent 安装准备随后进入连接检查；检查失败，没有选用候选或创建 Agent 行。正式结果见 [失败截图](../04-fast-agent-connection-failed.png) 和 [数据复核](../after-fast-failure.json)：原 22 个会话、7 个 Agent 保留。
- [安全诊断](safe-diagnostics.json)：北京时间 18:02:32.943 发出 `initialize`，18:02:46.733 仅收到两块错误输出，共 14,549 字节；未观察到任何协议响应。18:02:47.285 连接层记录错误并关闭。它没有等待到 60 秒握手超时。原错误文本和异常类未保存，不能由字节数判定原因。
- [离线包复核](offline-package.json) 使用同一受管 uv 0.12.18、Python 3.12.13 和本次缓存，仅增加 `--offline`，安装到明确命名的系统临时目录。安装进程仅移除 `UV_CONFIG_FILE`，保留 HOME；两个命令退出均为 0，没有启动 Agent。
- uv 实际生成的 [启动脚本](generated-console-script.txt) 导入 `fast_agent.cli.commands.acp:main`，对应模块存在。依赖为 `fast-agent-mcp==0.10.1`、`agent-client-protocol==0.10.1`。
- [入口导入检查](entrypoint-import.json) 成功，`main` 可调用；[Typer 参数装配](command-assembly.json) 成功，得到 31 个参数。均没有调用 `main`、命令回调、Agent 对象或配置加载，错误输出为 0，进程组已回收。
- [进一步模块导入](startup-module-imports.json) 成功导入 FastAgent 和 ACPServer 类模块，没有构造对象。该进程使用写入、网络与子进程审计护栏，一次 `socket.bind` 尝试被拦截后由库吞掉。该结果仅证明此受限独立检查成功，不能等同未经护栏的正式启动。

## 官方发布包的独立问题

[PyPI 0.10.1 元数据](https://pypi.org/pypi/fast-agent-acp/0.10.1/json) 指向的 [官方 wheel](https://files.pythonhosted.org/packages/c8/5d/d23a2a602c49ba0fbce30a9beeeb884f80638b035a200bfc5b02ec1b4b92/fast_agent_acp-0.10.1-py3-none-any.whl) 于 2026-08-04 发布，大小 5,874 字节，SHA-256 为 `61f970f52a01e38c1c151a65c9c8a08ca2357fe0f4bcb9073897170f6898837b`。本次只在内存读取官方 wheel 文件清单，没有安装或执行它。

这个 wheel 只有 5 个 `dist-info` 文件，没有 `fast_agent_acp` 模块，却声明 `fast-agent-acp = fast_agent_acp.cli:main`。依赖包又声明同名脚本指向存在的 `fast_agent.cli.commands.acp:main`。离线重建实际得到后一入口，因此不能把 wrapper 缺模块写成本次正式失败的根因；原失败候选已回收，原脚本内容不再可核对。

## 仍未知

正式那次启动的具体异常，以及命令回调之后在哪一步退出，仍未定位。缺账号、模型配置、CLI 装配、依赖接口或网络问题都没有被证据认定为根因。独立导入与参数装配也不能替代正式安装版连接成功。

没有扩大为 Agent 主函数或独立握手。下一次真实探针前须确认实际配置查找路径、继承的 `FAST_AGENT_HOME` 是否存在及是否启用既有 MCP；保持真实 HOME，并明确任务自有工作目录中的官方日志/会话目录可能写入范围。不得修改外部 Agent、自动改变依赖版本或以写入/网络护栏产生的错误替代原错误。

临时目录的精确清理见 [cleanup.json](cleanup.json)；受管 uv、Python 与共享下载缓存保留。
