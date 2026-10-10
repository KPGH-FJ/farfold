import { MCP_MANAGEMENT_STRINGS as M } from "./mcp_management_strings";
export const MCP_REMOVE_STRINGS = {
  ...M,
  heading: "移除 MCP 配置",
  reviewRemove: "审阅移除…",
  confirm: "确认移除配置",
  requested: "所选操作",
  remove: "移除已停用的配置条目",
  inspect: "正在核查已停用条目与移除范围，尚未修改配置。",
  reopen: "查看 MCP 移除状态",
  retired: "此次移除审阅已失效。请重新查询清单并审阅。",
  verified: "所选配置条目已移除，此次完整配置报告中已无该名称。",
  observed:
    "当前核对未见所选条目，配置符合移除预期；不能据此确认此前移除是否成功。",
  mismatch: "此次配置核对或完整报告与移除预期不同，请查看下方结果。",
  unknown: "本次移除结果仍未确认。可以只读核对当前配置；不会自动重试移除。",
  rejected: "官方程序拒绝了本次移除。请重新查询并审阅当前配置。",
  missing: "此次完整配置报告中无此名称",
  present: "此次完整配置报告中仍有此名称",
  configurationAbsent: "已核对所选条目不在用户配置中",
  parent: "MCP 配置容器",
  parentHandling: {
    mayRemainEmpty: "移除该条目后，可能保留空的 MCP 配置容器。",
    preserveSiblings: "移除该条目，保留其他 MCP 配置条目。",
  },
  parentOutcomes: {
    absent: "已不存在",
    empty: "保留空容器",
    nonempty: "仍有配置内容",
  },
  original: "此前移除请求的结果",
  checkingResult: "正在只读核对当前配置，不会再次移除。",
  checkUnknown:
    "此次只读核对未能确认当前配置。此前请求的结果不变，不会再次移除。",
  notice:
    "确认后从所示用户配置中移除这一条目，会影响以后沿用同一设置的其他对话。不会自动停用其他条目，不发送对话消息。",
  applicability:
    "移除配置不代表已断开当前连接或停止程序，也不证明当前对话已更新。不删除文件、不退出认证或清除凭据。",
  effects:
    "官方程序会使用已有配置、登录状态和环境，可能访问网络及维护自身状态。只请求移除此配置条目，不启动其 MCP 程序。",
  limits:
    "可审阅已有用户配置中已明确停用的条目并移除；不测试连接、调用工具或清除认证。",
  errors: {
    ...M.errors,
    targetEnabled: "条目尚未明确停用。请先停用并重新查询清单，再审阅移除。",
    cancelled: "已请求取消本次操作；是否结束及配置结果请以上方状态为准。",
  },
} as const;
