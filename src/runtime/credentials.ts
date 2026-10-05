import { invoke } from "@tauri-apps/api/core";

export type ApiType = "chat-completions" | "responses" | "messages";
export interface CredentialGrant {
  agentId: string;
  envName: string;
  overrideExisting: boolean;
}
export interface Credential {
  id: string;
  label: string;
  provider: string;
  purpose?: "authentication";
  endpoint: string;
  apiType: string;
  models: string[];
  revision: string;
  complete: boolean;
  deleting: boolean;
  grants: CredentialGrant[];
}
export interface CredentialInput {
  id: string | null;
  label: string;
  provider: string;
  endpoint: string;
  apiType: string;
  key: string;
  models: string[];
}
export interface ServiceSelection {
  id: string;
  model: string;
}

export function preservesLegacyService(
  saved: Credential | null,
  draft: CredentialInput,
): boolean {
  return (
    saved != null &&
    !saved.complete &&
    saved.endpoint === draft.endpoint &&
    saved.apiType === draft.apiType &&
    saved.models.length === draft.models.length &&
    saved.models.every((model, index) => model === draft.models[index])
  );
}
export interface ServiceIdentity extends ServiceSelection {
  fingerprint: string;
}
export interface ServiceCapability {
  apiTypes: string[];
  validatedApiTypes: string[];
  selectionScope: string;
  unavailableReason: string | null;
}
export const getServiceCapabilities = (agentId: string) =>
  invoke<ServiceCapability>("service_capabilities", { agentId });

const changeEvent = "credentials-changed";
export function subscribeCredentialChanges(callback: () => void): () => void {
  window.addEventListener(changeEvent, callback);
  return () => window.removeEventListener(changeEvent, callback);
}
export const listCredentials = () => invoke<Credential[]>("credential_list");
export async function saveCredential(
  input: CredentialInput,
): Promise<Credential> {
  const result = await invoke<Credential>("credential_save", { input });
  window.dispatchEvent(new Event(changeEvent));
  return result;
}
export async function deleteCredential(id: string): Promise<void> {
  await invoke("credential_delete", { id });
  window.dispatchEvent(new Event(changeEvent));
}

export async function revokeCredential(
  id: string,
  agentId: string,
  envName: string,
): Promise<void> {
  await invoke("credential_revoke", { id, agentId, envName });
  window.dispatchEvent(new Event(changeEvent));
}

export type ApiSource =
  { kind: "saved"; id: string } | { kind: "draft"; input: CredentialInput };
export interface ApiInput {
  requestId: string;
  source: ApiSource;
  model: string | null;
}
export interface ApiResult {
  requestId: string;
  status: "success" | "failed" | "cancelled";
  message: string;
  models: string[];
  responseText?: string;
  latencyMs?: number;
}
export const fetchApiModels = (input: ApiInput) =>
  invoke<ApiResult>("api_models", { input });
export const testApi = (input: ApiInput) =>
  invoke<ApiResult>("api_test", { input });
export const cancelApiRequest = (requestId: string) =>
  invoke<boolean>("api_test_cancel", { requestId });

/** Owns only an explicit diagnostic, with no automatic retries or retained keys. */
export class ApiRequestScope {
  private active: string | null = null;
  constructor(private readonly cancelRequest = cancelApiRequest) {}
  async run(
    request: (id: string) => Promise<ApiResult>,
    receive: (result: ApiResult) => void,
    fail: (reason: unknown) => void,
  ): Promise<void> {
    if (this.active) return;
    const id = crypto.randomUUID();
    this.active = id;
    try {
      const result = await request(id);
      if (this.active === id) {
        if (result.requestId !== id)
          throw new Error("Unexpected diagnostic result");
        receive(result);
      }
    } catch (error) {
      if (this.active === id) fail(error);
    } finally {
      if (this.active === id) this.active = null;
    }
  }
  async cancel(): Promise<boolean> {
    const id = this.active;
    if (!id) return true;
    try {
      const confirmed = await this.cancelRequest(id);
      // A normal result may arrive while cancellation is in flight.
      return confirmed || this.active !== id;
    } catch (error) {
      if (this.active !== id) return true;
      throw error;
    }
  }
  invalidate(): void {
    const id = this.active;
    this.active = null;
    if (id) void this.cancelRequest(id).catch(() => undefined);
  }
}
