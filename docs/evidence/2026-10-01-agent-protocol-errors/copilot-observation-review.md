# Copilot 登录取消与终端记录：独立观察审查

本次只读审查已保存的 JSON 与界面控制项，并核对采样脚本；没有运行 Cargo、应用、Agent 或任何新的进程观察。候选身份以 [candidate-install.json](candidate-install.json) 的正式应用 SHA256、四文件一致及签名结果为准。以下仅覆盖 Copilot 此次启动、返回、取消与记录重开，不是登录成功或实际请求验收。

## 已有证据支持的结论

1. [copilot-login-running.json](copilot-login-running.json) 在 06:50:12–06:50:58 的有界采样中捕获登录父子：PID 19405 / 19406，启动时间均为 06:50:22。两者分别精确匹配所选程序的 loader `login` 与平台程序 `login` 命令，资料文件夹与原准备目标一致。[运行控制项](copilot-running-controls.txt) 显示“暂时收起”“取消”，没有借此记录账号授权成功。
2. [copilot-returned.json](copilot-returned.json) 的 06:50:51 采样仍是上述同一 PID + 启动时间，登录命令仍匹配；[返回控制项](copilot-returned-controls.txt) 仍显示运行态的收起和取消。可以说明返回准备页时已观察到的登录仍由原进程执行，没有在该采样中换成新登录父子。
3. [after-copilot-cancel.json](after-copilot-cancel.json) 在 06:51:10 检查先前采样身份。其 `previousProcessesStillPresent` 只剩原 App、Amp 及原 Copilot 连接父子，19405 / 19406 的同身份均未出现。[verify_candidate.py](verify_candidate.py) 先取全局进程表，再按 PID 与启动时间比对先前身份，这一步不依赖当前父进程归属，能避免仅靠后代列表漏掉已重新归属的已知登录进程。该收据还记录原 33 个索引、原程序设置、原未发字段和既有设置未变，431 个输入及正式二进制保持。
4. [copilot-record-hidden.txt](copilot-record-hidden.txt) 显示“已取消此次操作，账号设置是否改变仍需检查”和“查看终端记录”；[展开控制项](copilot-record-open-controls.txt) 显示同一取消结果，记录按钮变成“暂时收起”。[copilot-record-reopened.json](copilot-record-reopened.json) 在 06:51:50 的约 135 毫秒单次采样仅见原四个进程身份，没有匹配的登录命令或新增登录父子。可以记录：**记录重开后的采样未观察到第二次登录启动，界面仍保留取消结果。**

## 必须保留的限制

- 重开收据是单次短采样，[observe_login.py](observe_login.py) 并非系统级创建/退出事件追踪。因此不能证明从点击重开到采样结束的整个区间绝无短暂启动，也不能把控制项名称单独当成后端未启动的证据。此前返回收据同样只证明其采样时的原身份保留。
- 取消收据证明已采样登录父子的同身份不再存在，未取得它们的实际退出码、信号或 PTY 回收终态；不得据此独立声称所有后代都已 reap，或把退出原因确定为某个信号。
- 45 秒运行收据还捕获了短暂 `(open)` helper：19421 / 06:50:23，但 [all-observed-processes.json](all-observed-processes.json) 的当时合并发生在 06:50:56，来源只有返回采样等三文件，未包含尚未完成写盘的运行收据。此次取消的全局身份比对没有该 helper，不能扩成“全部登录后代均验证退出”。Helper 的 `lsofExitCode=1` 也不能单独证明退出原因。
- `matchedLoginArgv=[]` 只表示所检查的公开启动形状没有匹配。采样器只从当时正式应用的后代中选取目标，随后精确比对指定程序，不能排除未被采样的新进程或全局任意同名命令。
- 原数据摘要保持不等于外部账号设置未变；界面明确保留了需检查的未知状态。这里没有读取凭据、没有确认登录、没有发送测试消息。

现有范围无证据阻断；后续安装记录应使用上述有限表述，保留“采样身份已退出”和“未观察新启动”的区别，不升级为全区间、全后代或账号成功结论。
