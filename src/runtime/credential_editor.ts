import type { Credential, CredentialInput } from "./credentials";
import { API_EDITOR_STRINGS as S } from "./api_editor_strings";

const hasControlCharacter = (value: string) =>
  /[\u0000-\u001f\u007f-\u009f]/.test(value);
const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** Match the existing service boundary; no request is needed to validate input. */
export function credentialEndpointIssue(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#") ||
      byteLength(value) > 300 ||
      hasControlCharacter(value)
    )
      return S.endpointInvalid;
    if (
      ["/chat/completions", "/responses", "/messages", "/models"].some((path) =>
        url.pathname.replace(/\/+$/, "").endsWith(path),
      )
    )
      return S.endpointPath;
    return null;
  } catch {
    return S.endpointRequired;
  }
}

export const validCredentialModel = (value: string) =>
  !!value.trim() &&
  byteLength(value.trim()) <= 256 &&
  !hasControlCharacter(value);

export function credentialKeyIssue(
  key: string,
  retainingKey: boolean,
): string | null {
  if (!key) return retainingKey ? null : S.keyRequired;
  return !key.trim() || byteLength(key) > 16384 || hasControlCharacter(key)
    ? S.keyInvalid
    : null;
}

export function credentialSaveIssue(
  draft: CredentialInput,
  {
    retainingKey,
    preservingLegacy,
    pendingModel,
  }: {
    retainingKey: boolean;
    preservingLegacy: boolean;
    pendingModel: string;
  },
): string | null {
  if (!draft.label.trim()) return S.labelRequired;
  if (
    [draft.label, draft.provider].some(
      (value) => byteLength(value) > 300 || hasControlCharacter(value),
    )
  )
    return S.metadataInvalid;
  if (!preservingLegacy) {
    const endpointIssue = credentialEndpointIssue(draft.endpoint);
    if (endpointIssue) return endpointIssue;
    if (!["chat-completions", "responses", "messages"].includes(draft.apiType))
      return S.formatRequired;
  }
  const keyIssue = credentialKeyIssue(draft.key, retainingKey);
  if (keyIssue) return keyIssue;
  if (
    !preservingLegacy &&
    (!draft.models.length ||
      draft.models.length > 500 ||
      draft.models.some((model) => !validCredentialModel(model)))
  )
    return S.modelsRequired;
  return pendingModel.trim() ? S.pendingModel : null;
}

export function credentialDraft(item: Credential | null): CredentialInput {
  return {
    id: item?.id ?? null,
    label: item?.label ?? "",
    provider: item?.provider ?? "",
    endpoint: item?.endpoint ?? "",
    apiType: item?.apiType ?? "chat-completions",
    key: "",
    models: [...(item?.models ?? [])],
  };
}

export function credentialDraftChanged(
  draft: CredentialInput,
  original: CredentialInput,
  pendingModel = "",
) {
  return (
    pendingModel.length > 0 ||
    ["label", "provider", "endpoint", "apiType", "key"].some(
      (key) =>
        draft[key as keyof CredentialInput] !==
        original[key as keyof CredentialInput],
    ) ||
    draft.models.length !== original.models.length ||
    draft.models.some((model, index) => model !== original.models[index])
  );
}

/** Fetched models remain candidates until explicitly selected and added. */
export function modelCandidates(
  models: string[],
  added: string[],
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return [...new Set(models)].filter(
    (model) =>
      !added.includes(model) && model.toLocaleLowerCase().includes(needle),
  );
}

/** An unfinished model entry must never disappear into an otherwise valid save. */
export function credentialDraftForSave(
  draft: CredentialInput,
  pendingModel: string,
): CredentialInput | null {
  return pendingModel.trim() ? null : draft;
}
