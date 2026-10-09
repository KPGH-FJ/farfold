import { useSyncExternalStore } from "react";
import { draftPersistence } from "./draft_storage";
import {
  parseTemplateEdit,
  type TemplateEditDraft,
} from "./prompt_template_data";
import { PROMPT_TEMPLATES as S } from "./prompt_template_strings";

let value: TemplateEditDraft | null = null;
let edited = false;
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((fn) => fn());
}

export const templateEditDrafts = {
  read: () => value,
  snapshot: () => value,
  update(next: TemplateEditDraft | null) {
    const storage = draftPersistence.snapshot();
    if (!storage.ready || storage.interactionLocked)
      throw new Error(storage.error ?? S.changed);
    const parsed = parseTemplateEdit(next);
    if (JSON.stringify(value) === JSON.stringify(parsed)) return;
    value = parsed;
    edited = true;
    publish();
    draftPersistence.changed();
  },
  clear() {
    this.update(null);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
export function restoreTemplateEdit(restored: TemplateEditDraft | null) {
  if (edited) return;
  value = restored;
  publish();
}
export function useTemplateEditDraft(): TemplateEditDraft | null {
  return useSyncExternalStore(
    templateEditDrafts.subscribe,
    templateEditDrafts.snapshot,
    templateEditDrafts.snapshot,
  );
}
