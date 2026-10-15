import { useEffect, useRef, useState } from "react";
import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
  type FileFeedbackDestination,
} from "../runtime/drafts";
import type { ThreadState } from "../runtime/session_types";
import { useContentOwner } from "./useContentOwner";

/** Route only to the input that this conversation actually displays. */
export function useFileFeedbackDestination(
  thread: ThreadState,
  active: boolean,
  draftKey: string,
  preparedCurrent?: (() => boolean) | null,
): FileFeedbackDestination {
  const owns = useContentOwner(thread, active);
  const mounted = useRef(true);
  const [, update] = useState(0);
  const current = useRef<{
    destination: FileFeedbackDestination;
    retired: boolean;
    owns: () => boolean;
  } | null>(null);
  const previous = current.current;
  if (
    !previous ||
    previous.destination.draftKey !== draftKey ||
    !previous.owns()
  ) {
    if (previous) previous.retired = true;
    const generation = composerDrafts.generation(draftKey);
    const selection = () =>
      JSON.stringify([
        newConversationChoice.agentId,
        newConversationChoice.cwd,
        newConversationChoice.service,
      ]);
    const choice = draftKey === "new" ? selection() : null;
    const entry: {
      retired: boolean;
      owns: () => boolean;
      destination: FileFeedbackDestination;
    } = {
      retired: false,
      owns: () => {
        const valid =
          !entry.retired &&
          mounted.current &&
          current.current === entry &&
          owns() &&
          composerDrafts.generation(draftKey) === generation &&
          (draftKey !== "new" ||
            (selection() === choice &&
              thread.identity === "draft" &&
              Boolean(preparedCurrent?.())));
        if (!valid) entry.retired = true;
        return valid;
      },
      destination: {
        threadKey: thread.key,
        draftKey,
        isCurrent: () => {
          const draft = composerDrafts.read(draftKey);
          return (
            entry.owns() &&
            !draftPersistence.snapshot().interactionLocked &&
            (draftKey !== "new" ||
              (!thread.running &&
                !thread.submitting &&
                !thread.uncertainPrompt &&
                !draft.sendPending &&
                !draft.pendingConversation &&
                !draft.queueEdit))
          );
        },
      },
    };
    current.current = entry;
  }
  useEffect(() => {
    mounted.current = true;
    // StrictMode cleanup retires old handlers; its replay needs a fresh route.
    if (current.current?.retired) update((value) => value + 1);
    const observe = () => {
      if (current.current && !current.current.owns())
        update((value) => value + 1);
    };
    // Observe selection A -> B -> A synchronously, before a queued render.
    const unsubscribe = composerDrafts.subscribe(observe);
    const unwatchStorage = draftPersistence.subscribe(observe);
    return () => {
      mounted.current = false;
      if (current.current) current.current.retired = true;
      unsubscribe();
      unwatchStorage();
    };
  }, []);
  return current.current!.destination;
}
