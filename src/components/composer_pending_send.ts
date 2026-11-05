import { composerDrafts } from "../runtime/drafts";

// Only the current in-memory writer may release this draft's pending flag.
// Ordinary edits retain it; a new send or replaced draft revokes the old writer.
const owners = new Map<string, object>();

export function beginComposerPendingSend(key: string): () => void {
  const owner = {};
  const generation = composerDrafts.generation(key);
  owners.set(key, owner);
  composerDrafts.update(key, (draft) => ({ ...draft, sendPending: true }));
  return () => {
    if (owners.get(key) !== owner) return;
    owners.delete(key);
    if (composerDrafts.generation(key) !== generation) return;
    const draft = composerDrafts.read(key);
    if (!draft.sendPending || draft.pendingConversation) return;
    composerDrafts.update(key, (current) => ({
      ...current,
      sendPending: false,
    }));
  };
}
