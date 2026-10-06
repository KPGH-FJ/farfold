const key = "__farfold_observation_v1";
let s = globalThis[key];
if (!s) {
  s = {
    epoch: epochSeed,
    version: 0,
    observation: null,
    observationExpires: null,
    invalidatedBy: null,
    roots: new WeakSet(),
  };
  const invalidate = (category) => {
    // Keep only the first fixed cause that invalidated this observation. Do
    // not inspect the event, its target, or any page/input contents.
    if (s.observation) s.invalidatedBy = category;
    s.version++;
    s.observation = null;
  };
  s.observer = new MutationObserver(() => invalidate("mutation"));
  s.observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  for (const event of ["input", "change", "scroll", "resize"])
    addEventListener(event, () => invalidate(event), true);
  s.roots.add(document);
  globalThis[key] = s;
}
const flush = () => {
  if (s.observer.takeRecords().length) {
    if (s.observation) s.invalidatedBy = "mutation";
    s.version++;
    s.observation = null;
  }
};
flush();
const roots = [document];
let inspected = 0,
  incomplete = false;
for (let i = 0; i < roots.length; i++) {
  for (const el of roots[i].querySelectorAll("*")) {
    if (++inspected > 4000) {
      incomplete = true;
      break;
    }
    if (el.shadowRoot) {
      roots.push(el.shadowRoot);
      if (!s.roots.has(el.shadowRoot)) {
        s.roots.add(el.shadowRoot);
        s.observer.observe(el.shadowRoot, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        if (s.observation) s.invalidatedBy = "shadow_root";
        s.version++;
        s.observation = null;
      }
    }
  }
  if (incomplete) break;
}
const version = () => s.epoch + ":" + s.version;
const visible = (el) => {
  if (
    !el ||
    !el.isConnected ||
    el.closest('[hidden],[inert],[aria-hidden="true"]')
  )
    return false;
  let depth = 0;
  for (let p = el; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (
      ++depth > 80 ||
      style.visibility !== "visible" ||
      Number(style.opacity) === 0 ||
      style.contentVisibility === "hidden"
    )
      return false;
  }
  const style = getComputedStyle(el),
    rect = el.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility === "visible" &&
    Number(style.opacity) > 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth
  );
};
const editable =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const sensitive = (el) => {
  const type = (el.getAttribute("type") || "text").toLowerCase();
  const a = (el.getAttribute("autocomplete") || "").toLowerCase();
  const name = [
    el.id,
    el.getAttribute("name"),
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
    ...[...(el.labels || [])].map((label) => label.textContent),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    ["password", "file", "email", "tel", "hidden"].includes(type) ||
    (a && a !== "off" && a !== "on") ||
    /password|passwd|secret|token|credential|otp|captcha|verification|one.?time|login|sign.?in|username|account|e.?mail|phone|密码|口令|密钥|验证码|验证|登录|邮箱|账号|账户|手机/i.test(
      name,
    )
  );
};
const blocked =
  incomplete ||
  roots.some((root) =>
    [...root.querySelectorAll("input,textarea,select")].some(
      (el) => el.type === "password" || (visible(el) && sensitive(el)),
    ),
  );
const screenshotReason = () =>
  roots.length > 1 ||
  document.querySelector(editable + ",iframe,frame,object,embed") !== null
    ? "页面含可编辑内容或嵌入页面，暂不能安全截图"
    : null;
const clippedText = (el, max) => {
  let text = "",
    count = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()) && count++ < 4000;) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(
        "script,style,noscript,template,iframe,object,embed," + editable,
      ) ||
      !visible(parent)
    )
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const onscreen = [...range.getClientRects()].some((r) => {
      const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2,
        y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth &&
        document.elementFromPoint(x, y) === parent
      );
    });
    if (!onscreen) continue;
    text += node.textContent + " ";
    if (text.length > max) break;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, max);
};
const actions = (el) => {
  if (
    !visible(el) ||
    el.disabled ||
    el.readOnly ||
    el.getAttribute("aria-disabled") === "true" ||
    el.closest('[contenteditable]:not([contenteditable="false"])')
  )
    return [];
  if (el.matches("input,textarea")) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !sensitive(el) &&
      (el.tagName === "TEXTAREA" || ["text", "search", "url"].includes(type))
      ? ["input"]
      : [];
  }
  if (el.matches('button,a[href],[role="button"]') && !el.closest("label"))
    return ["click"];
  return [];
};
const label = (el) =>
  (
    el.getAttribute("aria-label") ||
    [...(el.labels || [])].map((item) => clippedText(item, 160)).join(" ") ||
    (el.matches("input,textarea")
      ? el.getAttribute("placeholder")
      : clippedText(el, 160)) ||
    el.getAttribute("title") ||
    ""
  ).slice(0, 160);
if (mode === "check")
  return {
    blocked,
    documentVersion: version(),
    screenshotReason: screenshotReason(),
    url: location.href,
  };
if (mode === "observe") {
  s.observation = null;
  s.observationExpires = null;
  s.invalidatedBy = null;
  if (blocked)
    return {
      blocked: true,
      reason: "页面含登录、验证或敏感输入，请改用公开页面",
    };
  const id = observationSeed,
    map = new Map(),
    nodes = [];
  let scanned = 0,
    truncated = false;
  for (const el of document.querySelectorAll(
    'button,a[href],input,textarea,[role="button"]',
  )) {
    if (++scanned > 4000 || nodes.length >= 128) {
      truncated = true;
      break;
    }
    const allowed = actions(el);
    if (!allowed.length) continue;
    const rect = el.getBoundingClientRect(),
      ref = "n" + (nodes.length + 1);
    const semantic = label(el);
    map.set(ref, {
      el,
      semantic,
      allowed: allowed.join(","),
      html: el.outerHTML,
    });
    nodes.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      label: semantic,
      actions: allowed,
      bounds: {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.min(rect.right, innerWidth) - Math.max(0, rect.x),
        height: Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y),
      },
    });
  }
  const text = document.body ? clippedText(document.body, 65536) : "";
  s.observation = {
    id,
    map,
    navigation,
    url: location.href,
    version: version(),
    expires: Date.now() + 30000,
  };
  s.observationExpires = s.observation.expires;
  return {
    blocked: false,
    url: location.href.slice(0, 4096),
    title: document.title.slice(0, 512),
    text,
    observationId: id,
    documentVersion: version(),
    nodes,
    truncated: truncated || text.length >= 65536,
    screenshotReason: screenshotReason(),
  };
}
const observation = s.observation;
s.observation = null;
const diagnostics = () => {
  const expires = observation?.expires ?? s.observationExpires;
  const age = Number.isFinite(expires) ? Date.now() - (expires - 30000) : null;
  const value = {};
  // Omit unavailable, backwards-clock and old ages rather than fabricating a
  // capped duration. The original thirty-second expiry remains unchanged.
  if (Number.isSafeInteger(age) && age >= 0 && age <= 300000)
    value.observationAgeMs = age;
  if (!observation && s.invalidatedBy)
    value.observationInvalidatedBy = s.invalidatedBy;
  return value;
};
const reject = (reason, guardClass) => ({
  applied: false,
  outcome: "rejected",
  reason,
  ...(guardClass ? { guardClass } : {}),
  ...diagnostics(),
  pageChanged: false,
  navigationChanged: false,
  observationId,
  documentVersion: version(),
});
if (mode !== "act" || blocked) return reject("页面不允许此操作");
const stale = (guardClass) =>
  reject("页面或操作目标已变化，请重新观察", guardClass);
// Preserve the original short-circuit order and comparisons. These classes
// describe a rejection; they never establish permission or dispatch facts.
if (Date.now() > deadline) return stale("deadline");
if (!observation) return stale("observation_missing");
if (observation.id !== observationId) return stale("observation_id");
if (observation.navigation !== navigation) return stale("navigation");
if (observation.url !== location.href) return stale("url");
if (observation.version !== version()) return stale("version");
if (Date.now() > observation.expires) return stale("expired");
const entry = observation.map.get(nodeRef),
  el = entry?.el;
if (
  !entry ||
  !visible(el) ||
  entry.semantic !== label(el) ||
  entry.html !== el.outerHTML ||
  entry.allowed !== actions(el).join(",")
)
  return reject("操作目标已变化，请重新观察");
const rect = el.getBoundingClientRect(),
  x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2,
  y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2,
  hit = document.elementFromPoint(x, y);
if (!hit || (hit !== el && !el.contains(hit)))
  return reject("操作目标被遮挡，请先查看页面");
if (kind === "input") {
  if (
    !actions(el).includes("input") ||
    typeof inputText !== "string" ||
    inputText.length > 8192
  )
    return reject("此输入不受支持");
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, inputText);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
} else if (kind === "click" && actions(el).includes("click")) el.click();
else return reject("此操作不受支持");
await Promise.resolve();
flush();
return {
  applied: true,
  outcome: "dispatched",
  ...diagnostics(),
  pageChanged:
    observation.version !== version() || observation.url !== location.href,
  navigationChanged: observation.url !== location.href,
  observationId,
  documentVersion: version(),
};
