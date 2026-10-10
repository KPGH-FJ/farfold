import { useEffect, useRef } from "react";
import { draftPersistence } from "../runtime/drafts";
import { DraftLocationOwner } from "../runtime/draft_location_owner";
import type { WorkLocationIntent } from "./WorktreeDialog";

/** A transient choice belongs to one unchanged new-conversation draft. */
export function useDraftWorkLocation(options: {
  context: string;
  active: boolean;
  allowed: () => boolean;
  onBegin: () => void;
  onApply: (path: string) => void;
}) {
  const owner = useRef(new DraftLocationOwner());
  owner.current.observe(options.context, options.active);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => () => owner.current.retire(), []);
  const begin = (): WorkLocationIntent | null => {
    if (!latest.current.allowed()) return null;
    latest.current.onBegin();
    const token = owner.current.begin();
    const isCurrent = () =>
      owner.current.owns(token) && latest.current.allowed();
    return {
      isCurrent,
      apply: async (path) => {
        if (!isCurrent()) return false;
        await draftPersistence.flush();
        if (!isCurrent()) return false;
        owner.current.retire();
        latest.current.onApply(path);
        await draftPersistence.flush();
        return true;
      },
    };
  };
  return { owner, begin };
}
