/** Sidebar row presentation copy (untitled fallback + relative time). */
export const SIDEBAR_STRINGS = {
  untitled: "未命名会话",
  justNow: "刚刚",
  minutesAgo: (n: number) => `${n} 分钟前`,
  hoursAgo: (n: number) => `${n} 小时前`,
  daysAgo: (n: number) => `${n} 天前`,
  monthsAgo: (n: number) => `${n} 个月前`,
  yearsAgo: (n: number) => `${n} 年前`,
} as const;
