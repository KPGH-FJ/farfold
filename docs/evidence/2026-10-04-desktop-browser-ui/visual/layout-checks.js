await document.fonts.ready;
const query = new URLSearchParams(location.search);
if (document.title.includes("full-layout")) {
  const pane = document.querySelector(".artifact-pane");
  pane.classList.add("expanded", "browser-full");
}
const rect = (el) => {
  const r = el.getBoundingClientRect();
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    right: r.right,
    bottom: r.bottom,
  };
};
const visible = (el) =>
  !!el &&
  !!el.getClientRects().length &&
  getComputedStyle(el).visibility !== "hidden";
const send = document.querySelector(".c-send");
const composer = document.querySelector(".composer-box");
const pane = document.querySelector(".artifact-pane");
const request = document.querySelector(".browser-read-request");
const controls = [...document.querySelectorAll("button,input,textarea")].filter(
  visible,
);
const horizontalClips = controls
  .filter((el) => {
    const r = rect(el);
    return r.x < -1 || r.right > innerWidth + 1;
  })
  .map((el) => ({
    label: el.getAttribute("aria-label") || el.textContent,
    rect: rect(el),
  }));
const info = {
  viewport: { width: innerWidth, height: innerHeight },
  theme: document.documentElement.dataset.theme,
  pageOverflow: document.documentElement.scrollWidth > innerWidth,
  horizontalClips,
  visibleControlCount: controls.length,
  send: visible(send) ? rect(send) : null,
  sendWithinViewport:
    !visible(send) ||
    (rect(send).bottom <= innerHeight &&
      rect(send).x >= 0 &&
      rect(send).right <= innerWidth),
  composer: visible(composer)
    ? {
        ...rect(composer),
        radius: getComputedStyle(composer).borderRadius,
        background: getComputedStyle(composer).backgroundColor,
      }
    : null,
  request: visible(request) ? rect(request) : null,
  pane: visible(pane) ? rect(pane) : null,
  errors: window.__reviewErrors || [],
  tabs: [...document.querySelectorAll(".artifact-content-tabs > button")]
    .filter(visible)
    .map((el) => ({
      label: el.textContent,
      background: getComputedStyle(el).backgroundColor,
      border: getComputedStyle(el).borderStyle,
      color: getComputedStyle(el).color,
    })),
  listIndent: document.querySelector(
    ".workspace-message-agent .markdown-body ol",
  )
    ? getComputedStyle(
        document.querySelector(".workspace-message-agent .markdown-body ol"),
      ).paddingLeft
    : null,
  returnToChat: [...document.querySelectorAll("button")]
    .filter(visible)
    .some((el) => el.textContent.includes("返回对话确认")),
};
return JSON.stringify(info);
