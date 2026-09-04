import { invoke } from "@tauri-apps/api/core";
import { PI_RUNTIME_IDENTITY, type PiRpcResponse } from "./pi";
import { OPENCODE_RUNTIME_IDENTITY } from "./opencode";

export type LifeModelCategory = "preference" | "identity" | "goal";
export type ProposalDecision = "pending" | "approved" | "rejected";
export type MaterializationState = "not_materialized" | "materialized";
export type InjectionStatus = "prepared" | "sent" | "failed";

export interface SourceEnvelope {
  id: string;
  farfoldSessionId: string;
  runtimeProductId: string;
  runtimeInstallationId: string;
  runtimeBuildId: string;
  runtimeAdapterId: string;
  runtimeConnectionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  nativeTimestamp: string;
  sourceText: string;
  capturedAt: number;
}

export interface SourceEnvelopeInput {
  farfoldSessionId: string;
  nativeEntryId: string;
}

export interface LifeModelProposal {
  id: string;
  category: LifeModelCategory;
  key: string;
  before: string | null;
  after: string;
  source: SourceEnvelope;
  confidence: number;
  confidenceBasis: "explicit_user_statement";
  reason: string;
  providerPayloadPreview: string;
  decision: ProposalDecision;
  materialization: MaterializationState;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  materializedAt: number | null;
}

export interface CanonicalLifeModelItem {
  id: string;
  category: LifeModelCategory;
  key: string;
  value: string;
  sources: SourceEnvelope[];
  proposalId: string;
  createdAt: number;
  updatedAt: number;
}

export interface LifeModelSourceWithdrawal {
  id: string;
  itemId: string;
  sourceId: string;
  runtimeProductId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  createdAt: number;
}

export interface InjectionManifest {
  id: string;
  runtimeProductId: string;
  nativeSessionId: string;
  itemIds: string[];
  providerPayloadPreview: string;
  channel: string;
  status: InjectionStatus;
  createdAt: number;
  finishedAt: number | null;
}

export interface LifeModelSnapshot {
  version: number;
  enabled: boolean;
  proposals: LifeModelProposal[];
  items: CanonicalLifeModelItem[];
  sourceWithdrawals: LifeModelSourceWithdrawal[];
  injectionManifests: InjectionManifest[];
}

export interface LifeModelSourceCandidate {
  candidateId: string;
  farfoldSessionId: string;
  runtimeProductId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  nativeTimestamp: string;
  sourceText: string;
}

export interface CreateProposalInput {
  category: LifeModelCategory;
  key: string;
  after: string;
  reason: string;
  source: SourceEnvelopeInput;
}

export interface UpdateProposalInput {
  proposalId: string;
  category: LifeModelCategory;
  key: string;
  after: string;
  reason: string;
}

export interface PreparedInjection {
  manifestId: string;
  commandArgument: string | null;
  contextText: string;
  providerPayloadPreview: string;
  itemIds: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [];
    })
    .join("\n")
    .trim();
}

export function parseLifeModelSources(
  response: PiRpcResponse,
  farfoldSessionId: string | null,
  nativeSessionId: string | null,
): { candidates: LifeModelSourceCandidate[]; leafId: string | null } {
  if (response.command !== "get_entries" || !nativeSessionId) {
    return { candidates: [], leafId: null };
  }
  const data = record(response.data);
  const leafId = typeof data?.leafId === "string" ? data.leafId : null;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const candidates = entries.flatMap((entry) => {
    const source = record(entry);
    const message = record(source?.message);
    if (
      source?.type !== "message" ||
      typeof source.id !== "string" ||
      message?.role !== "user"
    ) {
      return [];
    }
    const sourceText = messageText(message.content);
    if (!sourceText || !farfoldSessionId) return [];
    if (
      typeof source.timestamp !== "string" &&
      typeof source.timestamp !== "number"
    )
      return [];
    const nativeTimestamp = String(source.timestamp).trim();
    if (!nativeTimestamp) return [];
    return [
      {
        candidateId: `${nativeSessionId}:${source.id}`,
        farfoldSessionId,
        runtimeProductId: PI_RUNTIME_IDENTITY.productId,
        nativeSessionId,
        nativeEntryId: source.id,
        nativeTimestamp,
        sourceText,
      },
    ];
  });
  return { candidates, leafId };
}

export function parseOpenCodeLifeModelSources(
  history: unknown,
  farfoldSessionId: string | null,
  nativeSessionId: string | null,
): LifeModelSourceCandidate[] {
  if (!nativeSessionId || !Array.isArray(history)) return [];
  return history.flatMap((entry) => {
    const message = record(entry);
    const info = record(message?.info);
    if (
      info?.role !== "user" ||
      typeof info.id !== "string" ||
      (typeof info.sessionID === "string" && info.sessionID !== nativeSessionId)
    ) {
      return [];
    }
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const sourceText = parts
      .flatMap((part) => {
        const item = record(part);
        return item?.type === "text" &&
          item.ignored !== true &&
          typeof item.text === "string"
          ? [item.text]
          : [];
      })
      .join("\n")
      .trim();
    if (!sourceText || !farfoldSessionId) return [];
    const time = record(info.time);
    const created = time?.created;
    if (typeof created !== "string" && typeof created !== "number") return [];
    const nativeTimestamp = String(created).trim();
    if (!nativeTimestamp) return [];
    return [
      {
        candidateId: `${nativeSessionId}:${info.id}`,
        farfoldSessionId,
        runtimeProductId: OPENCODE_RUNTIME_IDENTITY.productId,
        nativeSessionId,
        nativeEntryId: info.id,
        nativeTimestamp,
        sourceText,
      },
    ];
  });
}

export function getLifeModelSnapshot(): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_snapshot");
}

export function createLifeModelProposal(
  input: CreateProposalInput,
): Promise<LifeModelProposal> {
  return invoke("lifemodel_create_proposal", { input });
}

export function updateLifeModelProposal(
  input: UpdateProposalInput,
): Promise<LifeModelProposal> {
  return invoke("lifemodel_update_proposal", { input });
}

export function approveLifeModelProposal(
  proposalId: string,
): Promise<LifeModelProposal> {
  return invoke("lifemodel_approve_proposal", { proposalId });
}

export function rejectLifeModelProposal(
  proposalId: string,
): Promise<LifeModelProposal> {
  return invoke("lifemodel_reject_proposal", { proposalId });
}

export function deleteLifeModelItem(
  itemId: string,
): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_delete_item", { itemId });
}

export function withdrawLifeModelSource(
  itemId: string,
  sourceId: string,
): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_withdraw_source", {
    input: { itemId, sourceId },
  });
}

export function setLifeModelEnabled(
  enabled: boolean,
): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_set_enabled", { enabled });
}

export function prepareLifeModelInjection(
  runtimeProductId: "pi" | "opencode",
  nativeSessionId: string,
  itemIds: string[],
): Promise<PreparedInjection> {
  return invoke("lifemodel_prepare_injection", {
    runtimeProductId,
    nativeSessionId,
    itemIds,
  });
}

export function finishLifeModelInjection(
  manifestId: string,
  sent: boolean,
): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_finish_injection", { manifestId, sent });
}
