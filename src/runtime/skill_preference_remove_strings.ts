import { SKILL_MANAGEMENT_STRINGS as S } from "./skill_management_strings";

export const SKILL_PREFERENCE_REMOVE_STRINGS = {
  ...S,
  heading: "清除技能启停偏好",
  reviewRemove: "审阅清除启停偏好…",
  confirm: "确认清除偏好",
  requested: "所选操作",
  remove: "清除这一技能位置的启停偏好",
  configured: "此位置的启停偏好",
  inspect: "正在核查技能位置与清除范围，尚未修改配置。",
  reopen: "查看技能偏好清除状态",
  retired: "此次清除审阅已失效。请重新查询清单并审阅。",
  verified: "此位置的启停偏好已清除，当前技能状态已核对。",
  observed:
    "当前已无此位置的启停偏好，配置符合清除预期；不能据此确认此前修改是否成功。",
  mismatch: "此次配置或技能报告与清除预期不同，请查看下方结果。",
  unknown: "本次清除结果仍未确认。可以只读核对当前配置；不会自动重试清除。",
  rejected: "官方程序拒绝了本次清除。请重新查询并审阅当前配置。",
  configurationAbsent: "已核对此位置的启停偏好不在用户配置中",
  parent: "技能设置",
  parentHandling: {
    mayRemainEmpty: "清除后可能保留空的技能设置。",
    preserveSiblings: "清除此位置的启停偏好，保留其他技能规则和设置。",
  },
  parentOutcomes: {
    absent: "已不存在",
    empty: "保留空设置",
    nonempty: "仍有其他配置内容",
  },
  original: "此前清除请求的结果",
  checkingResult: "正在只读核对当前配置，不会再次清除。",
  checkUnknown:
    "此次只读核对未能确认当前配置。此前请求的结果不变，不会再次清除。",
  notice:
    "确认后仅从所列用户配置中清除此技能位置的启停规则，会影响以后沿用同一设置的对话。其他范围的规则仍可能生效，当前启用状态以技能报告为准。",
  applicability:
    "不删除技能文件。当前对话是否采用此设置尚未验证，不会自动重启对话。",
  errors: {
    ...S.errors,
    preferenceNotConfigured:
      "此技能位置未保存启停偏好，无需清除。尚未修改配置。",
  },
} as const;
