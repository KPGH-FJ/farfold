# 标准终端认证解析回归（2026-09-30）

范围：当前锁定 `agent-client-protocol 2.2.0` / schema `1.9.1`，`src-tauri/src/auth.rs` 的标准 `type: terminal` 路线。工程回归，不代表真实 Agent 或安装版登录验收。

## 修复前失败证据

先仅添加 `standard_terminal_keeps_configured_invocation_over_legacy_metadata`，未修改解析实现，执行：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked auth::tests::standard_terminal_keeps_configured_invocation_over_legacy_metadata -- --exact
```

退出码 `101`，结果 `0 passed; 1 failed; 255 filtered out`。输入同时包含标准终端 `args: ["--standard-login"]`、`env` 与旧 `_meta["terminal-auth"]` 完整命令。失败断言：

```text
left:  Some(["/unexpected/legacy-login", "legacy"])
right: Some(["/usr/local/bin/example", "acp", "--standard-login"])
```

根因：旧完整命令在解析时先被保留，调用生成又优先选它，从而替换了标准终端要求使用的已配置程序及基础参数。

## 修复与通过证据

标准终端先按当前 schema 的 `AuthMethod::Terminal` 解码并采用标准 `args/env`，不再让旧扩展改写命令或将其分类为密钥路径。未修改缺省 Agent 的旧扩展处理。

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked auth::tests
```

退出码 `0`，结果 `16 passed; 0 failed; 0 ignored; 241 filtered out`。过滤字符串也匹配了两项 `manual_auth::tests`。新增失败用例通过；新增 `legacy_terminal_metadata_still_supplies_full_invocation` 验证缺省 Agent 的旧完整命令、环境和未知 `_meta` 内容保持。原有标准终端、已核实 Qwen 返回检查、Codex 密钥声明及描述不推导命令等用例通过。

## 证据边界

- 本次没有升级依赖、改动连接管理器或密钥授权策略。
- 未覆盖 typed 初始化重新序列化后的显式 `agent`/未知 `type` discriminator 保留问题，也未修改该行为；原始 handshake 不被本解析函数覆写。
- 标准环境字段经 schema 读取及传给调用生成得到验证；真实 Agent 的终端登录、外部账号、安装版返回与续接仍需另行验证。
