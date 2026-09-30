# 通用实际工作目录：实现与受控回归草案

仅供下一片实施定位；当前不修改产品源文件，不运行 Cargo 或外部 Agent。

## 最小改动

1. 在 `src-tauri/src/acp_client/process.rs` 现有启动落点，将 `self.agent.spawn_process()` 替换为本地小函数。函数使用官方 `AcpAgentConfig` 的 `command()`、`arguments()`、`environment()` getter，创建 `std::process::Command`，按原义设置 argv/env，然后在同一命令对象上调用 `current_dir(&self.cwd)` 和 `process_group(0)`，转为 `async_process::Command`，保留三个管道并返回同类型 Child/streams。
2. 启动后既有 ProcessControl、ConnectionLife、stderr 有界处理、supervisor 注册、Child wait/reap、ByteStreams 连接全部沿用。不得设置全局进程 cwd；不得以 PWD 环境变量或 shell 包装代替实际 cwd；不得增加 Agent 名称分支、private HOME、配置写入或上游修改。
3. 普通连接的 cwd 已由 `manager::validate_cwd_async` 验证并 canonicalize；安装候选 `probe_launch` 使用已有应用数据目录。`current_dir` 的操作系统错误必须在产生 Child 前返回，沿现有失败清理释放连接预留；不得退回父进程目录继续启动。
4. 如现有 `ProcessTransport.cwd: String` 保持为连接实际路径，可直接传 `Path::new(&self.cwd)`，无需修改 manager wire/API。是否增加更强的 `PathBuf` 内部字段以避免反复转换，应以真实必要性决定。

锁定 SDK 2.2.0 没有 cwd 设置接口；不能调用 spawn_process 后再改变父进程目录。采用同类型 Child 的最小依赖变动是新增直接精确依赖 `async-process = '=2.5.0'`，复用当前 Cargo.lock 已存在的版本及 checksum，官方协议依赖仍为 2.2.0。只更新根 package 的依赖列表，不更新其它包。

[crates.io 官方版本元数据](https://crates.io/api/v1/crates/async-process/2.5.0) 已核实该版本发布于 2025-09-14，未撤销，满足 ≥7 天规则；来源字段、响应摘要和锁定 checksum 对照见 `async-process-release.json`。

## 最小受控回归

使用当前仓库已有的 `/usr/bin/python3` 协议 fixture 方式，经真正 `AcpManager::connect`/候选 `probe_launch` 和 `ProcessTransport` 启动，不能只测试 Command 构造。独立 fixture 在启动时向给定自有绝对路径写安全 JSON：`os.getcwd()`、公开 argv 字面值、仅测试公开环境值、HOME 是否与父进程相同。它尝试写一个相对 marker，然后只响应 initialize，不运行任何真实 Agent。

| 回归                               | 必要断言                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 所选目录含空格、与测试进程目录不同 | fixture 的实际 cwd 等于所选目录；相对 marker 只出现在该目录；初始化 ready；修复前真实失败                    |
| 同一 Agent 并发连接两个目录        | 两个精确 Child 各自记录自己的 cwd 和相对 marker；父进程 cwd 保持；无互串                                     |
| 安装候选探测                       | `probe_launch` 的 Child cwd 是应用数据目录，不是父目录或候选 venv 路径；探测退出无进程残留                   |
| command/args/env 原义              | 含空格、`$literal` 等字面参数逐字保留；测试 env 覆盖和 HOME 继承保持；不用 env_clear；不把日志扩展为环境全文 |
| 启动前目录消失                     | connect 返回失败，fixture 绝对 marker 不存在，连接预留可释放/重试；不回退到其它目录                          |

上述新增用例稳定后复用现有 `lifecycle_tests` 的挂起 initialize、取消、shutdown、stderr 与后代回收回归，不因低层启动改动删除或放松所有权断言。无需增加新的运行账本或固定等待来制造时序。

fixture 最小正文草案如下。`observed_path` 和 `expected_cwd` 都由测试创建的 TempDir 派生；真实 cwd 不匹配时只向自有绝对路径写观察，不向错误目录写任何 marker，因此红测试不会污染父进程工作区。

```python
import json, os, sys
from pathlib import Path

observed_path, expected_cwd, literal = sys.argv[1:4]
cwd = Path.cwd().resolve()
expected = Path(expected_cwd).resolve()
Path(observed_path).write_text(json.dumps({
    "cwd": str(cwd),
    "literal": literal,
    "publicEnvironment": os.environ.get("FIXTURE_CWD_PUBLIC"),
    "homeMatchesParent": os.environ.get("HOME") == sys.argv[4],
}))
if cwd == expected:
    Path("relative-marker").write_text("controlled-only")
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {
            "protocolVersion": 1,
            "agentInfo": {"name": "controlled-cwd", "version": "1"},
            "agentCapabilities": {}, "authMethods": [],
        }}), flush=True)
```

该 fixture 未运行；未来测试仍需实际覆盖红/绿输出、关闭与进程回收。观察只限测试提供的公开值，不读取其它环境或用户配置。

## 安装复验边界

先运行必要 Rust checks 并独立审查，再冻结同一正式应用。通用 cwd 修复需要实际安装版验证，受控 fixture 不能替代。安装检查仍只在 initialize 通过后提交候选；失败保留原数据和选择。

fast-agent 默认启动可能由外部程序自行在应用数据目录创建 `.fast-agent/sessions`。复验前记录相关目录/已知配置存在性和必要摘要，不把“Farfold 没写配置”扩大成“外部 Agent 零写入”。仍用用户/目录原定模型、真实 HOME、正常环境，不能为了验证改模型或配置。若再次遇到同名入口缺模块，单独保留公开生成入口/声明，不能把它归为 cwd 修复失败或手改外部包。
