import { SKILL_MANAGEMENT_STRINGS as S } from "./skill_management_strings";
export const MCP_MANAGEMENT_STRINGS = {
  ...S,
  heading: "MCP 启用偏好",
  reviewEnable: "审阅启用偏好…",
  reviewDisable: "审阅停用偏好…",
  enable: "确认启用偏好",
  disable: "确认停用偏好",
  enabled: "启用",
  disabled: "停用",
  inspect: "正在读取保存的偏好与此文件夹的配置报告，尚未修改配置。",
  target: "MCP 名称",
  configured: "用户配置中的偏好",
  reported: "此文件夹的配置报告",
  verified: "保存的偏好与此次配置报告均已核对为所选状态。",
  observed:
    "当前保存的偏好与配置报告符合所选状态；不能据此确认此前修改是否成功。",
  mismatch: "保存的偏好或此次配置报告与所选状态不一致，请查看下方结果。",
  overridden:
    "官方程序报告该配置项还受其他设置影响；此信息不能确定此次配置报告或当前连接的状态。",
  missing: "此次配置报告中未找到该 MCP",
  reopen: "查看 MCP 修改状态",
  notice:
    "仅修改所示用户配置中的启用偏好，会影响以后沿用同一设置的其他对话；保留该条目的程序、参数、认证设置和其他设置，不发送对话消息。",
  preservation: "保留其他配置值；配置文件的注释与排版可能变化。",
  applicability:
    "保存的启用偏好不代表当前对话的连接或工具状态。不会自动断开、连接或重启对话。",
  limits:
    "仅可审阅已有用户配置中的启用偏好。此处不添加服务器、不办理认证，也不测试连接或调用工具。",
  legacy: "本次报告未提供修改入口，请重新查询清单。",
  reasons: {
    unsafeLabel: "此条目的名称无法安全展示，暂不能修改。",
    unsupportedTransport: "此条目的连接方式尚不支持修改。",
    ambiguousTarget: "此名称对应的配置尚不明确，暂不能修改。",
    incompleteInventory: "本次清单不完整，暂不能修改。",
  },
  errors: {
    ...S.errors,
    targetChanged: "MCP 配置条目或报告已变化，请重新查询并审阅。",
    inventoryIncomplete: "MCP 清单读取不完整，无法审阅修改。",
  },
} as const;
