首个可靠性候选 `8f6abc185b35257b4fd86d21ca14818943dc39115495d80100d0ccf602f347f4` 未通过安装验证。

Pi 原测试会话在旧安装版可恢复；此候选 initialize 正常往返后、session/load 之前失败。正式旧行 env JSON 存在格式差异，set_agent_handshake 将序列化字符串作为配置身份比较，误拒绝。未修改真实数据库以绕过；返回源码修复语义比较并保留原子防旧结果覆盖要求。失败截图 11-candidate1-pi-handshake-save-failed.png。最终候选须重新恢复同一会话并真实续发。
