// Local demonstration state; does not read a file or fetch a page.
export const demoPage = "https://example.com/research-notes";
export function webpageEvent(page = {}, action, url) {
  const current = { url: demoPage, granted: false, open: false, ...page };
  if (action === "open") return { ...current, open: true };
  if (action === "hide") return { ...current, open: false };
  if (action === "grant")
    return {
      ...current,
      granted: true,
      message: "已记录本页演示许可，未执行真实读取。",
    };
  if (action === "revoke")
    return {
      ...current,
      granted: false,
      message: "已撤回后续读取许可。已经交给 Agent 的内容不会因此删除。",
    };
  if (action === "navigate")
    return {
      ...current,
      url,
      granted: false,
      message: "已换页，上一个页面的许可已撤回。新页面尚未分享。",
    };
  if (action === "close" || action === "disconnect")
    return {
      ...current,
      open: false,
      granted: false,
      message:
        action === "close"
          ? "页面已关闭，读取许可已撤回。"
          : "连接已结束，读取许可已撤回。",
    };
  return current;
}
export function fileReadEvent(task, path, phase) {
  return { filePreviewStates: { ...task.filePreviewStates, [path]: phase } };
}
