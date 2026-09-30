# 启动错误：前端固定文案与安全边界

本片仅修改 `src/runtime/ui_error.ts`，新增 `ui_error.test.ts` 与 `agents.startup-errors.test.ts`。没有修改 Agent 入口、安装状态、自动重试、凭据或程序选择行为，没有操作正式应用或运行实际 Agent；受控 IPC 测试不代表安装验收。

连接、重新连接、显式安装及首次连接中的安装失败继续复用原有 `uiError`。仅完整固定码或标准 `Error: ` 包装的完整固定码显示下列产品文案，不显示底层错误正文，也不宣称远端拒绝或版本不兼容：

| 固定码                     | 显示文案                                       |
| -------------------------- | ---------------------------------------------- |
| `AGENT_INITIALIZE_FAILED`  | 连接检查未完成，请检查程序或启动设置后重试     |
| `AGENT_INITIALIZE_TIMEOUT` | 等待连接检查超时，请稍后重试                   |
| `AGENT_CONNECTION_ENDED`   | 连接在检查完成前结束，请检查程序后重试         |
| `AGENT_START_FAILED`       | 程序未能启动，请检查程序文件和资料文件夹后重试 |

带后缀、额外正文、换行、NUL、前缀、首尾空白、额外 `Error:` 空白或对象字段的输入不匹配。包含这些启动诊断命名空间的装饰输入（含中文前缀和大小写变化）同样退回调用处原有通用错误，防止进入既有短中文错误直通分支。既有 `AUTH_REQUIRED` 及安全的应用中文错误保持原语义。测试使用虚构 `secret-canary`，没有读取真实秘密。

## 红绿证据

- [frontend-red.json](frontend-red.json)：原实现两文件共 27 项，17 失败 / 10 成功，固定错误码在纯函数与三个真实 hook 入口均被折叠为通用错误。该收据先于生产改动。
- [frontend-green.json](frontend-green.json)：初始映射及既有参数、Agent 展示、集中用词检查，五文件 45 项成功；对应初次 typecheck 成功。
- [frontend-decorated-red.json](frontend-decorated-red.json)：追加中文装饰码与 canary 反例，4 失败 / 7 成功，确认旧中文分支会直通这类正文。该结果保留，没有覆盖成成功。
- [frontend-final-green.json](frontend-final-green.json)：最终五文件 48 项成功，包含保留原有边界的新增三入口中文装饰回归。最终 [frontend-final-typecheck.json](frontend-final-typecheck.json) 退出 0。

hook 回归调用实际 `useAgents`，仅夹具化 React 存储与 IPC：连接和重新连接失败显示固定文案并释放忙状态；安装返回 `false`，仍保持 `stopped` 进度；首次安装检查失败不继续连接，不自动重试，用户再次操作才重试，审阅的公开模型输入逐字保留。重新连接仍返回原错误给既有调用者；固定文案是展示层结果，不把错误改成成功。被装饰的输入保持连接与安装各自原来的 fallback。没有修改按钮和恢复动作。

四条固定产品文案经新增禁用词回归及既有集中用词检查，未含 `PRODUCT.md` 禁用词。源码和本片证据已分别格式化。完整工程检查、正式候选身份及安装错误路径观察由根任务另行留证，不能用上述测试关闭真实接入或登录旅程。
