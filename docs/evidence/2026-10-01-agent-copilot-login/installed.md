# 安装验证：Copilot 登录启动、暂离与取消

2026-10-01 06:22–06:27（UTC+8），正式 `/Applications/Farfold.app` 使用 `eb075a7`。[安装收据](candidate-install.json)四文件一致、签名退出 0，二进制 `0919004293ec2c5b38b623d09648939ab86e24e976ed76b577b8c0ff24a4a80d`。本片验证登录程序启动与生命周期；账号授权、凭据和真实回复未测。

## 实际结果

1. 原 GitHub Copilot `1.0.89` 检查连接成功，自动模型读取结束但未提供可选模型；账号页原 `Log in with Copilot CLI` 方法现在提供可运行的“在终端登录”。见[截图](01-login-enabled.png)和[AX](login-enabled.txt)。没有手选模型或修改启动配置。
2. 明确点击一次后，[进程观察](login-processes.json)匹配已选 Node + 原绝对 `npm-loader.js` + `login`，及同包平台程序 + `login`；两个登录进程的实际工作目录都是原普通对话目录。匹配仅保存固定预期及布尔结果，不保存任意实参或环境。原接入进程与登录进程分开记录。
3. 暂离后目录显示“登录尚未结束 / 查看登录进度”，见[截图](02-login-away.png)和[AX](login-away.txt)。重新进入仍为相同两个 PID+启动时间身份，见[返回观察](login-returned-processes.json)；没有新建第二次登录。进行中与返回的[控件记录](login-running-controls.txt)、[返回控件](login-returned-controls.txt)刻意不包含终端内容。
4. 点击取消后界面显示“已取消此次操作，账号设置是否改变仍需检查”；[取消后采样](login-cancelled-processes.json)中两个已观察登录身份均不再出现在应用后代中；该采样未保存全局 PID 存活比较，不单独用它排除重挂父进程。最终全局身份核对见下文。收起输出后保存[取消截图](03-login-cancelled.png)与[AX](login-cancelled.txt)。取消不证明外部账号配置完全未变，也不证明登录成功或失败原因。
5. 返回[原 Amp 空稿](04-original-draft.png)，随后正常退出。没有输入凭据或终端文字，没有发送模型消息或通过协议调用 authenticate。

登录期间还捕获一个短暂 `(open)` 子进程，未取得其工作目录；没有检查它打开的网页、完成浏览器授权或交互。不能据此宣称浏览器未打开，或账号状态没有变化。未保存终端画面、输出正文或临时代码。

## 数据、协议与退出

[安装前](before-launch.json)至[最终退出](after-exit.json)的 430 构建输入无变化，原 33 条会话索引、37 个 Agent 启动配置、46 项设置及全部原未发字段摘要保持，无新增会话索引。[七个采样身份](all-observed-processes.json)按 PID+启动时间核对均结束；不将采样覆盖扩大为所有瞬时进程。

[安全协议元数据](protocol-metadata-final.json)有两个文件、2 次 initialize、2 次 session/new、2 次 session/set_config_option、1 次 other，0 prompt、0 authenticate。自动准备涉及会话和选项请求，不能称只执行 initialize；原持久选择及未发字段保持另由数据库摘要证明。终端 CLI 登录动作也不能被“0 authenticate”解释为没有执行登录。

[汇总核对](installed-checks.json)记录目标、目录、暂离身份、取消和请求计数；[重复应用清理](duplicate-app-cleanup.json)先核对四个文件，再精确移除本次打包副本，正式应用保留。原受管安装、账号配置及历史没有被本任务清理。

## 下一片已定位的问题

取消后收起终端，按钮仍为“继续登录”，另有真正启动方法的“在终端登录”。前者实际只展开旧输出，是文案误导；本候选尚未修复。下一片按已有 `terminalOutcome` 区分仍运行的交互与已结束记录，并验证查看记录不重跑。这个缺口不抹掉本片启动/暂离/取消的实际结果，也不当作完整 J6 成功。
