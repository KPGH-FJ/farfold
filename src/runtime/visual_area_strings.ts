import {
  formatVisualAreaPercent,
  type VisualAreaRect,
} from "./visual_area_coordinates";

export const VISUAL_AREA_STRINGS = {
  open: "选择意见区域",
  form: "意见区域",
  choose: "选择区域",
  confirm: "对此区域提意见",
  cancel: "取消选择",
  left: "左边（%）",
  top: "上边（%）",
  right: "右边（%）",
  bottom: "下边（%）",
  scope:
    "按当前画面的显示方向，从左上角起计算。可拖动选择，或填写四条边的位置（0–100%）。",
  invalid:
    "请填写 0–100% 的数字，最多四位小数；右边须大于左边，下边须大于上边。",
  changed: "画面尺寸已变化，请重新选择区域。已填写的数字仍保留。",
  empty: "选择区域后，再明确提意见；原有意见不会自动改变。",
  surface: "当前显示画面的区域选择",
  selection: (area: VisualAreaRect) =>
    `已选择：左 ${formatVisualAreaPercent(area.left)}%，上 ${formatVisualAreaPercent(area.top)}%，右 ${formatVisualAreaPercent(area.right)}%，下 ${formatVisualAreaPercent(area.bottom)}%。`,
} as const;
