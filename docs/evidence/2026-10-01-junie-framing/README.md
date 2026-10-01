# Junie：独立初始化输出形态观测

2026-10-01 14:56。目录指定的 Junie 3419.24.0 在本次独立探针中输出一行匹配请求 ID 的 JSON result；没有重现旧安装检查的 parse_error。**这不证明正式应用连接成功，也未定位旧失败根因。** 生产协议处理与正式候选均未修改。

## 实际结果

[观测收据](framing-observation.json)记录一次 initialize（404 字节加换行），没有其他协议请求。stdout 共 1,257 字节，是一行 1,256 字节加换行的有效 UTF-8 / Python JSON object，匹配 initialize result；未观察到 BOM、ANSI、NUL、空行或额外非 JSON 行，stderr 0 字节。正文未保存或打印。

探针使用官方归档、原入口及 `--acp=true`，cwd 为旧安装检查的 `/Users/tw/Library/Application Support/ai.farfold.desktop`，继承执行环境与 HOME。它没有认证、创建会话、读模型或发送消息。结果后由探针发 TERM，退出码 143；不能将这个主动结束写成 Agent 自行失败。3 个实际采样身份和原进程组均结束，探针自行移除了本次精确解压目录。

[执行回执](execution-exit.json)退出 0，执行前五个冻结文件摘要一致。[设计快照](design.md)、[输入](initialize-input.json)和[冻结清单](probe-source-final.json)保留执行前状态；[probe-run.json](probe-run.json)是 14:40 的准备记录，其未执行标志不代表最终结果。唯一下载见 [download.json](download.json)。后续只读归档检查结束后，本次归档及空临时父目录已按精确路径移除，见[清理回执](owned-download-cleanup.json)。

## 结论边界

- 原正式候选的两次 parse_error 与提前退出仍按[原记录](../2026-10-01-agent-protocol-errors/protocol-after-junie.json)保留为失败。本次结果只排除了“这个发行包在本次条件下必然输出非 JSON”这一假设。
- Python 只做有限形态判断，没有验证 SDK 的完整 envelope / initialize schema；它不会回复 malformed 消息错误。公开请求字段由源码核对，未执行正式 SDK 序列化器；请求 ID 与历史不同。
- 执行文件位于本次临时目录，环境来自本次 shell；正式安装位于应用数据目录并由 Farfold 启动。相同 cwd、版本和参数不代表启动条件完全相同。需先核对这些差异，再决定有依据的正式补验，不能放宽解析器、跳过任意输出或替换版本来制造成功。
- 正常环境下 Agent 自身可能读取或写入官方配置/日志；本次未审计这些内容，不能宣称外部配置零写入。进程结论只覆盖已采身份和原组，短命未采后代仍有观测边界。

后续公开实现核对发现，Farfold 生成的 `registry:junie` 目录含 Java classpath 分隔符；已有具体源码链与通用修正落点，见[路径调查](path-followup.md)。这是下一片待修复的问题，尚未用正式安装验证，也没有把原 parse_error 的正文原因补写成已知。

## 数据与工程

[执行后核对](data-after.json)：正式应用仍为 `4277a2a`，二进制 `28fda12158b7654b6f372dc6fb9668455fd250374196dff1181c8967c4111bcc`；450 项生产输入不变，正式应用未运行。原 36 索引、39 Agent 配置、48 设置及全部未发字段不变，没有新会话或新增设置。

[纯自检](selfcheck.json)的 12 项用例、语法和链接检查仅验证探针，不是产品验收。本次没有生产改动，不重跑无关工程测试或重装应用。Junie 安装、登录、首发和续接的未完成项保持开放。
