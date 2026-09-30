# Gemini 后续条目：仅公开资料预核对

读取时间：2026-09-30 20:38 左右；未下载或运行程序，未读写账号配置。本记录不构成安装、握手、认证或模型可用证据。

冻结目录快照中的条目是 `gemini` / Gemini CLI 0.62.0，npm 分发 `@google/gemini-cli@0.62.0`，参数 `--acp`，无目录注入变量。公开 [npm 单版本元数据](https://registry.npmjs.org/@google%2Fgemini-cli/0.62.0) 本次返回版本 0.62.0、Node `>=20`、入口 `bundle/gemini.js`；该响应没有 `scripts` 或 `dependencies` 字段，不据此推断归档全部内容或运行副作用。

[官方认证说明](https://geminicli.com/docs/get-started/authentication/)列出 Google 登录、Gemini API Key 与 Vertex AI 路线。Google 登录会使用浏览器并缓存凭据，部分组织账号需要 Cloud project；当前机器的实际账号、权益和 ACP 登录声明均未核实。

20:38 预核对时尚未取得发布时间：GitHub release API 返回 403 rate limit；npm 全包元数据读取两次均因响应不完整失败（第二次改用 gzip，仍为 IncompleteRead）。当时固定版本发布页可访问，但提取未得到可信发布时间；该阶段未作年龄判定或启动决定。

21:15 左右公开材料核对补完，见 [Gemini 固定版本证据](gemini/README.md)：官方 release 页明确显示 9/29 发布，tarball `Last-Modified` 为 9/29 21:25:46 GMT；截至本次读取该 release 不足 7 天，npm 精确发布时间仍未知。归档经完整性核对后完成只读清单检查，真实 manifest 与单版本元数据一致；包自身无 scripts、有可选依赖，未执行任何包代码。归档和固定 tag 下载均只在任务临时目录，已回收。

固定版本确认 `--acp` 的真实入口、四种登录方法、legacy models/modes 和 setter；Google 是 agent 登录，Gemini Key 只有 provider 扩展，没有 env 声明。官方 authenticate 会改变用户 selectedType，切换方法会清凭据缓存；未执行。当前 Farfold 的 Key/gateway 交付不能据此宣称已完成。`session/new` 认证失败使用通用 -32000，`session/load` 使用标准 authRequired，后续保留真实错误，不混合判断。

下一步按当前年龄规则确定目录安装是否可执行，再用正式安装入口验证 initialize、真实 authMethods、明确选择后的登录、显式模型读取、首发与冷恢复。用户账号不足时保留未测，不自动选择、保存或切换身份；不为通过改模型。本材料预核对不替代这些旅程证据。
