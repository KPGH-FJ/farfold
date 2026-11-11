/** Explicitly retained, memory-only form state. Never persists possible secrets. */
export interface CustomAgentDraft {
  name: string;
  command: string;
  args: string;
  envText: string;
  secretEntries?: { name: string; value: string }[];
}
let retained: CustomAgentDraft | null = null;
export const customAgentDraft = {
  read: () =>
    retained
      ? {
          ...retained,
          secretEntries: retained.secretEntries?.map((entry) => ({ ...entry })),
        }
      : null,
  keep: (draft: CustomAgentDraft) => {
    retained = {
      ...draft,
      secretEntries: draft.secretEntries?.map((entry) => ({ ...entry })),
    };
  },
  clear: () => {
    retained = null;
  },
};
export const hasCustomAgentDraft = (draft: CustomAgentDraft) =>
  [draft.name, draft.command, draft.args, draft.envText].some(
    (value) => value.length > 0,
  ) ||
  !!draft.secretEntries?.some(
    (entry) => entry.name.length > 0 || entry.value.length > 0,
  );
