# fast-agent-acp 0.10.1：同名 console 与缺失模块的本地复现材料

本材料尚未向外发布。不含用户路径、环境值、配置、凭据或会话；只说明公开包的静态事实。它不能作为正式应用原始错误的逐字复现。

## 已观察的包组合

Python 3.12.13 / uv 0.12.18；安装请求 `fast-agent-acp==0.10.1`；实际 `fast-agent-acp`、`fast-agent-mcp`、`agent-client-protocol` 都是 0.10.1。无需认证、配置或模型请求即可检查下面的 distribution 数据。

两份公开 `entry_points.txt` 均声明同一个 console 名：

```ini
# fast_agent_acp-0.10.1.dist-info/entry_points.txt
[console_scripts]
fast-agent-acp = fast_agent_acp.cli:main

# fast_agent_mcp-0.10.1.dist-info/entry_points.txt（只摘同名一项）
[console_scripts]
fast-agent-acp = fast_agent.cli.commands.acp:main
```

wrapper METADATA 声明 `Requires-Dist: fast-agent-mcp==0.10.1`。wrapper 的缓存 wheel RECORD 只有以下文件，没有任何 `fast_agent_acp` 模块：

```text
fast_agent_acp-0.10.1.dist-info/METADATA
fast_agent_acp-0.10.1.dist-info/WHEEL
fast_agent_acp-0.10.1.dist-info/entry_points.txt
fast_agent_acp-0.10.1.dist-info/licenses/LICENSE
fast_agent_acp-0.10.1.dist-info/RECORD
```

同包组合的已安装 site-packages 中，`fast_agent/cli/commands/acp.py` 存在，`fast_agent_acp/cli.py` 不存在。公开 wheel RECORD 不包含任何 `fast_agent_acp/` 模块文件，与实际目标模块存在性相互支持。

## 只检查包和生成入口的复现步骤

以下是可审阅的命令草案，本材料没有再次执行它们。使用自有新目录，不导入或运行 Agent；首次准备如缓存未命中会下载公开包。

```sh
uv venv --python python3.12 .venv
uv pip install --python .venv/bin/python fast-agent-acp==0.10.1
.venv/bin/python -I -B inspect_entrypoints.py
```

`inspect_entrypoints.py` 只读当前 venv 的公开 distribution 数据及生成的 console 脚本，输出公开目标和模块存在性，避免输出包含临时绝对路径的完整脚本：

```python
from importlib.metadata import distribution
from pathlib import Path
import sys

for name in ("fast-agent-acp", "fast-agent-mcp", "agent-client-protocol"):
    d = distribution(name)
    print(name, d.version)
    if name != "agent-client-protocol":
        for e in d.entry_points:
            if e.group == "console_scripts" and e.name == "fast-agent-acp":
                print("declared", e.name, e.value)
        print("wrapper_module_in_record", any(
            str(f).startswith("fast_agent_acp/") for f in d.files or []
        ))

script = Path(sys.executable).parent / "fast-agent-acp"
body = script.read_text()
for module in ("fast_agent_acp.cli", "fast_agent.cli.commands.acp"):
    selected = f"from {module} import main" in body
    path = Path(distribution("fast-agent-mcp").locate_file(
        module.replace(".", "/") + ".py"
    ))
    print("target", module, "generated", selected, "module_exists", path.is_file())
```

两个包对同名脚本的覆盖结果不应假定固定；需要记录实际生成目标。只检查包的步骤没有启动 console，不能称为 `ModuleNotFoundError` 的实测；静态可判定 wrapper 声明指向不存在的模块。

## 当前证据能与不能说明的结果

- 本地已保存两份实际 entry_points/RECORD 与生成入口，均来自原样离线安装，没有改包或重写脚本。新条件探针的实际 console 导入 `fast_agent.cli.commands.acp`；这个有效入口在自有可写目录只发 initialize，收到 0.10.1 回复。
- 更早的一次自有准备发现实际入口不含预期 MCP 导入，安全停止，没有启动 Agent；那次完整脚本已清理，不能补写它一定导入 wrapper 的事实。
- 正式应用失败只有 282 字节 stderr 的计量收据，无正文且失败候选已回收。不能把同名入口/缺模块、约一秒退出的相似现象直接写成正式失败的已确证根因。
- 工作目录问题有独立对照：有效 MCP 入口在 `/` 创建默认目录失败，在自有可写目录 initialize 成功。它与公开入口问题分别记录；任何修复都还需要同候选的真实安装验证。

可向维护者提交的最小问题是：便捷 wrapper 的 console 声明是否应指向已包含的有效模块，且两个 distributions 对同名 console 的重复 ownership 如何保持一致。当前没有对外提交，也没有替维护者 pin、patch 或发布包。
