import { useEffect, useState } from "react";
import {
  approveLifeModelProposal,
  createLifeModelProposal,
  deleteLifeModelItem,
  getLifeModelSnapshot,
  previewLastSourceResolution,
  rejectLifeModelProposal,
  resolveLastSource as resolveLifeModelLastSource,
  setLifeModelEnabled,
  updateLifeModelProposal,
  withdrawLifeModelSource,
  type CreateProposalInput,
  type LastSourceResolutionPreview,
  type LifeModelSnapshot,
  type LifeModelSourceCandidate,
  type ResolveLastSourceInput,
  type UpdateProposalInput,
} from "./lifemodel";

export function useLifeModelWorkspace() {
  const [lifeModelOpen, setLifeModelOpen] = useState(false);
  const [lifeModelSnapshot, setLifeModelSnapshot] =
    useState<LifeModelSnapshot | null>(null);
  const [lifeModelUnavailable, setLifeModelUnavailable] = useState<
    string | null
  >(null);
  const [lifeModelBusy, setLifeModelBusy] = useState(false);
  const [lifeModelSources, setLifeModelSources] = useState<
    LifeModelSourceCandidate[]
  >([]);
  const [selectedLifeModelItemIds, setSelectedLifeModelItemIds] = useState<
    string[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  async function loadLifeModel(): Promise<LifeModelSnapshot | null> {
    try {
      const snapshot = await getLifeModelSnapshot();
      setLifeModelSnapshot(snapshot);
      setLifeModelUnavailable(null);
      setSelectedLifeModelItemIds((current) =>
        current.filter((itemId) =>
          snapshot.items.some((item) => item.id === itemId),
        ),
      );
      return snapshot;
    } catch (reason) {
      setLifeModelSnapshot(null);
      setLifeModelUnavailable(String(reason));
      setSelectedLifeModelItemIds([]);
      return null;
    }
  }

  async function runLifeModelMutation(
    mutation: () => Promise<unknown>,
  ): Promise<void> {
    if (lifeModelBusy) return;
    setLifeModelBusy(true);
    try {
      await mutation();
      await loadLifeModel();
    } catch (reason) {
      setError(`LifeModel：${String(reason)}`);
    } finally {
      setLifeModelBusy(false);
    }
  }

  function mergeLifeModelSources(candidates: LifeModelSourceCandidate[]): void {
    if (!candidates.length) return;
    setLifeModelSources((current) => {
      const merged = new Map(
        [...current, ...candidates].map((candidate) => [
          candidate.candidateId,
          candidate,
        ]),
      );
      return [...merged.values()].slice(-30);
    });
  }

  function selectLifeModelItem(itemId: string, selected: boolean): void {
    setSelectedLifeModelItemIds((current) => {
      if (!selected) return current.filter((candidate) => candidate !== itemId);
      if (current.includes(itemId) || current.length >= 3) return current;
      return [...current, itemId];
    });
  }

  function openLifeModel(): void {
    setLifeModelOpen(true);
    void loadLifeModel();
  }

  function createProposal(input: CreateProposalInput): void {
    void runLifeModelMutation(() => createLifeModelProposal(input));
  }

  function updateProposal(input: UpdateProposalInput): void {
    void runLifeModelMutation(() => updateLifeModelProposal(input));
  }

  function approveProposal(proposalId: string): void {
    void runLifeModelMutation(() => approveLifeModelProposal(proposalId));
  }

  function rejectProposal(proposalId: string): void {
    void runLifeModelMutation(() => rejectLifeModelProposal(proposalId));
  }

  function deleteCanonicalItem(itemId: string): void {
    if (
      !window.confirm(
        "删除后，所有 Runtime 都不能再注入这条 canonical LifeModel 内容。来源 Proposal 审计会保留。确认删除？",
      )
    ) {
      return;
    }
    void runLifeModelMutation(async () => {
      await deleteLifeModelItem(itemId);
      setSelectedLifeModelItemIds((current) =>
        current.filter((candidate) => candidate !== itemId),
      );
    });
  }

  function withdrawCanonicalSource(itemId: string, sourceId: string): void {
    if (
      !window.confirm(
        "这只会撤销来源与 canonical item 的关联，不会修改 Pi 或 OpenCode 的原生历史。确认撤销？",
      )
    ) {
      return;
    }
    void runLifeModelMutation(() => withdrawLifeModelSource(itemId, sourceId));
  }

  function previewCanonicalLastSource(
    itemId: string,
    sourceId: string,
  ): Promise<LastSourceResolutionPreview> {
    return previewLastSourceResolution(itemId, sourceId);
  }

  async function resolveCanonicalLastSource(
    input: ResolveLastSourceInput,
  ): Promise<void> {
    setLifeModelBusy(true);
    try {
      const snapshot = await resolveLifeModelLastSource(input);
      setLifeModelSnapshot(snapshot);
      if (input.choice === "delete_canonical") {
        setSelectedLifeModelItemIds((current) =>
          current.filter((candidate) => candidate !== input.itemId),
        );
      }
    } catch (reason) {
      setError(`LifeModel：${String(reason)}`);
      throw reason;
    } finally {
      setLifeModelBusy(false);
    }
  }

  function changeLifeModelEnabled(enabled: boolean): void {
    void runLifeModelMutation(async () => {
      await setLifeModelEnabled(enabled);
      if (!enabled) setSelectedLifeModelItemIds([]);
    });
  }

  useEffect(() => {
    void loadLifeModel();
  }, []);
  return {
    error,
    clearError: () => setError(null),
    controls: {
      open: lifeModelOpen,
      snapshot: lifeModelSnapshot,
      candidates: lifeModelSources,
      selectedItemIds: selectedLifeModelItemIds,
      unavailable: lifeModelUnavailable,
      busy: lifeModelBusy,
      onOpen: openLifeModel,
      onClose: () => setLifeModelOpen(false),
      onReload: () => void loadLifeModel(),
      onSources: mergeLifeModelSources,
      onSnapshot: setLifeModelSnapshot,
      onCreate: createProposal,
      onUpdate: updateProposal,
      onApprove: approveProposal,
      onReject: rejectProposal,
      onDelete: deleteCanonicalItem,
      onWithdrawSource: withdrawCanonicalSource,
      onPreviewLastSource: previewCanonicalLastSource,
      onResolveLastSource: resolveCanonicalLastSource,
      onEnabled: changeLifeModelEnabled,
      onSelectItem: selectLifeModelItem,
      onClearSelection: () => setSelectedLifeModelItemIds([]),
    },
  };
}
export type LifeModelWorkspace = ReturnType<
  typeof useLifeModelWorkspace
>["controls"];
