// In-memory demonstration metadata only. No secret text, storage or requests.
export const API_FORMATS = {
  responses: "Responses",
  "chat-completions": "Chat Completions",
  messages: "Messages",
};
export const normalizedEndpoint = (value = "") => {
  try {
    return new URL(value.trim()).href.replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
};
export const apiSourceIdentity = (service = {}) =>
  JSON.stringify([normalizedEndpoint(service.endpoint), service.format]);
const configurationIdentity = (service) =>
  JSON.stringify([
    apiSourceIdentity(service),
    service.models || [],
    service.demoKey === true,
    service.secretRevision || 0,
  ]);
export const apiRecordVersion = (service) =>
  JSON.stringify([
    service?.id,
    service?.name,
    service?.provider,
    configurationIdentity(service || {}),
    service?.revision || 0,
  ]);
export function apiEndpointIssue(value = "") {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.length > 300 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      return "请输入不含账号、密码或查询参数的 HTTPS 基础地址。";
    if (
      ["/chat/completions", "/responses", "/messages", "/models"].some((path) =>
        url.pathname.replace(/\/+$/, "").endsWith(path),
      )
    )
      return "请填写基础地址，不包含具体请求路径。";
    return null;
  } catch {
    return "请填写完整的 HTTPS 基础地址。";
  }
}
export const validModel = (value) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.trim().length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
export function initialApiDraft(item = {}) {
  const source = {
    id: null,
    name: "",
    provider: "",
    endpoint: "",
    format: "responses",
    models: [],
    demoKey: false,
    revision: 0,
    secretRevision: 0,
    ...structuredClone(item),
  };
  return {
    ...source,
    models: [...source.models],
    newDemoKey: false,
    keySource: source.demoKey ? apiSourceIdentity(source) : null,
    originalRevision: source.revision,
    originalConfiguration: configurationIdentity(source),
  };
}
export function changeApiDraft(draft, key, value) {
  const next = { ...draft, [key]: value, revision: (draft.revision || 0) + 1 };
  if (apiSourceIdentity(next) !== apiSourceIdentity(draft))
    Object.assign(next, { demoKey: false, newDemoKey: false, keySource: null });
  return next;
}
export const confirmDemoKey = (draft) => ({
  ...draft,
  demoKey: true,
  newDemoKey: true,
  keySource: apiSourceIdentity(draft),
  secretRevision: (draft.secretRevision || 0) + 1,
  revision: (draft.revision || 0) + 1,
});
export const draftKeyReady = (draft) =>
  !!draft.demoKey && draft.keySource === apiSourceIdentity(draft);
export function apiDraftIssue(draft, pendingModel = "") {
  if (!draft.name.trim() || draft.name.length > 160)
    return "请填写不超过 160 字的配置名称。";
  const endpointIssue = apiEndpointIssue(draft.endpoint);
  if (endpointIssue) return endpointIssue;
  if (!Object.hasOwn(API_FORMATS, draft.format))
    return "请选择支持的接口格式。";
  if (!draftKeyReady(draft)) return "请为当前地址和接口选择演示密钥。";
  if (!draft.models.length || draft.models.some((model) => !validModel(model)))
    return "请至少添加一个有效模型 ID。";
  if (pendingModel.trim())
    return "还有一个模型 ID 尚未添加。请先添加，或清空输入后保存。";
  return null;
}
export function filterApiServices(services, query = "") {
  const search = query.trim().toLowerCase();
  return services.filter((service) =>
    `${service.name} ${service.provider || ""} ${service.models.join(" ")}`
      .toLowerCase()
      .includes(search),
  );
}
export function savedApiRecord(draft) {
  const issue = apiDraftIssue(draft);
  if (issue) throw new Error(issue);
  return {
    id:
      draft.id || `service-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
    name: draft.name.trim(),
    provider: draft.provider.trim() || "自定义来源",
    endpoint: normalizedEndpoint(draft.endpoint),
    format: draft.format,
    models: [...new Set(draft.models.map((model) => model.trim()))],
    demoKey: true,
    secretRevision: draft.secretRevision || 0,
    revision:
      (draft.originalRevision || 0) +
      (configurationIdentity(draft) !== draft.originalConfiguration ? 1 : 0),
  };
}
// One explicit diagnostic owns its result. Cancel/edit/close invalidate it.
export function createDiagnosticScope() {
  let serial = 0,
    active = null;
  return {
    begin() {
      active = ++serial;
      return active;
    },
    accepts(id) {
      return id === active;
    },
    finish(id) {
      if (id !== active) return false;
      active = null;
      return true;
    },
    invalidate() {
      active = null;
    },
  };
}
