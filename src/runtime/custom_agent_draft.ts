/** Explicitly retained, memory-only form state. Never persists possible secrets. */
export interface CustomAgentDraft {
  name: string;
  command: string;
  args: string;
  envText: string;
}
let retained: CustomAgentDraft | null = null;
export const customAgentDraft = {
  read: () => (retained ? { ...retained } : null),
  keep: (draft: CustomAgentDraft) => {
    retained = { ...draft };
  },
  clear: () => {
    retained = null;
  },
};
export const hasCustomAgentDraft = (draft: CustomAgentDraft) =>
  Object.values(draft).some((value) => value.length > 0);
