# GLM 两个账号方式同名

本轮 `959fc00` 安装版的 [GLM 菜单](glm-auth-options.txt)显示两个完全相同的“Z.AI API key”。[公开登记](glm-registration.json)确认它们具有不同 ID：`z-ai-api-key` 为缺省 Agent 声明，`z_ai_api_key` 是旧 `env_var` 声明，公开变量名 `Z_AI_API_KEY`。

实际未选择或执行任一方法，不能推断认证是否成功。已确认的界面问题是选择前无法从两个相同标签分辨路线。后续通用改进应在同名声明时提供已有公开说明和能力差异，不加入品牌分支，也不能用字段名猜测凭据交付或替用户选中其中一个。
