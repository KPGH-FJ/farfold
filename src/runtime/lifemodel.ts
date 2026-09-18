import { invoke } from "@tauri-apps/api/core";

export type LifeModelCategory = "preference" | "identity" | "goal";
export type ProposalDecision = "pending" | "approved" | "rejected";
export type MaterializationState = "not_materialized" | "materialized";
export type LifeModelSourceKind = "runtime_message" | "user_authored";
export type InjectionStatus =
  | "prepared"
  | "submission_accepted"
  | "turn_observed"
  | "sent"
  | "failed"
  | "abandoned";

export interface SourceEnvelope {
  id: string;
  sourceKind: LifeModelSourceKind;
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
  confidenceBasis:
    "explicit_user_statement" | "explicit_user_authored_confirmation";
  reason: string;
  providerPayloadPreview: string;
  decision: ProposalDecision;
  materialization: MaterializationState;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  materializedAt: number | null;
  replacesSourceId: string | null;
  expectedItemSha256: string | null;
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
  sourceKind: LifeModelSourceKind;
  runtimeProductId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  createdAt: number;
}

export interface InjectionManifest {
  id: string;
  farfoldSessionId: string;
  runtimeProductId: string;
  nativeSessionId: string;
  itemIds: string[];
  itemVersions: Array<{
    itemId: string;
    canonicalUpdatedAt: number;
    canonicalSha256: string;
  }>;
  providerPayloadPreview: string;
  channel: string;
  status: InjectionStatus;
  hostTurnId: string | null;
  createdAt: number;
  submissionAcceptedAt: number | null;
  turnObservedAt: number | null;
  finishedAt: number | null;
  failureReason: string | null;
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

export type LastSourceResolutionChoice =
  "delete_canonical" | "create_user_authored_proposal";

export interface LastSourceResolutionPreview {
  itemId: string;
  sourceId: string;
  category: LifeModelCategory;
  key: string;
  value: string;
  sourceKind: LifeModelSourceKind;
  runtimeProductId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  itemUpdatedAt: number;
  itemSha256: string;
}

export interface ResolveLastSourceInput {
  itemId: string;
  sourceId: string;
  expectedItemSha256: string;
  choice: LastSourceResolutionChoice;
}

export interface PreparedInjection {
  manifestId: string;
  commandArgument: string | null;
  contextText: string;
  providerPayloadPreview: string;
  itemIds: string[];
}

export interface FailedInjectionDecision {
  submitUserMessage: false;
  offerWithoutLifeModel: true;
  message: string;
}

export function failClosedInjectionDecision(
  runtimeLabel: "Pi" | "OpenCode",
  reason: unknown,
): FailedInjectionDecision {
  return {
    submitUserMessage: false,
    offerWithoutLifeModel: true,
    message: `LifeModel 上下文未注入，消息尚未发送（${runtimeLabel}）：${String(reason)}`,
  };
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

// Parses the Pi workspace `entries` section (`{ entries, leafId }`) into
// LifeModel source candidates. `sinceId` filters client-side to entries after
// the given leaf; an unknown cursor keeps the full tail and dedupes downstream.
export function parseLifeModelSources(
  data: unknown,
  farfoldSessionId: string | null,
  nativeSessionId: string | null,
  sinceId?: string | null,
): { candidates: LifeModelSourceCandidate[]; leafId: string | null } {
  if (!nativeSessionId) {
    return { candidates: [], leafId: null };
  }
  const snapshot = record(data);
  const leafId = typeof snapshot?.leafId === "string" ? snapshot.leafId : null;
  const all = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const cursorIndex = sinceId
    ? all.findIndex((entry) => record(entry)?.id === sinceId)
    : -1;
  const entries =
    sinceId && cursorIndex >= 0 ? all.slice(cursorIndex + 1) : all;
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
        runtimeProductId: "pi",
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
        runtimeProductId: "opencode",
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

export function previewLastSourceResolution(
  itemId: string,
  sourceId: string,
): Promise<LastSourceResolutionPreview> {
  return invoke("lifemodel_preview_last_source_resolution", {
    itemId,
    sourceId,
  });
}

export function resolveLastSource(
  input: ResolveLastSourceInput,
): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_resolve_last_source", { input });
}

export function setLifeModelEnabled(
  enabled: boolean,
): Promise<LifeModelSnapshot> {
  return invoke("lifemodel_set_enabled", { enabled });
}

export function prepareLifeModelInjection(
  farfoldSessionId: string,
  itemIds: string[],
): Promise<PreparedInjection> {
  return invoke("lifemodel_prepare_injection", {
    farfoldSessionId,
    itemIds,
  });
}
