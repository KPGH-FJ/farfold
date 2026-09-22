import { invoke } from "@tauri-apps/api/core";
export interface CredentialGrant {
  agentId: string;
  envName: string;
  overrideExisting: boolean;
}
export interface Credential {
  id: string;
  label: string;
  provider: string;
  endpoint: string;
  apiType: string;
  grants: CredentialGrant[];
  deleting: boolean;
}
export interface CredentialInput {
  id: string | null;
  label: string;
  provider: string;
  endpoint: string;
  apiType: string;
  key: string;
}
export const listCredentials = () => invoke<Credential[]>("credential_list");
export const saveCredential = (input: CredentialInput) =>
  invoke<Credential>("credential_save", { input });
export const grantCredential = (
  id: string,
  agentId: string,
  envName: string,
  replace: boolean,
) =>
  invoke<{ applied: boolean; conflicts: string[] }>("credential_grant", {
    id,
    agentId,
    envName,
    replace,
  });
export const revokeCredential = (
  id: string,
  agentId: string,
  envName: string,
) => invoke("credential_revoke", { id, agentId, envName });
export const deleteCredential = (id: string) =>
  invoke("credential_delete", { id });
// Controlled official destinations; selecting a provider never configures an Agent.
export const providerLinks: Record<
  string,
  { api: string; subscription?: string }
> = {
  openai: {
    api: "https://platform.openai.com/",
    subscription: "https://chatgpt.com/pricing/",
  },
  anthropic: {
    api: "https://console.anthropic.com/",
    subscription: "https://claude.com/pricing",
  },
  google: { api: "https://ai.google.dev/gemini-api/docs/pricing" },
};
