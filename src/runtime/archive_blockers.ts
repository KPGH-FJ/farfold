import { useSyncExternalStore } from "react";
import { composerDrafts } from "./drafts";
import { threads } from "./sessions";

type ArchiveBlockReason = ReturnType<typeof threads.archiveBlockReason>;

function subscribe(listener: () => void) {
  const unsubscribeThreads = threads.subscribe(listener);
  // Text, attachments, file feedback and saved queues share this subscription.
  const unsubscribeDrafts = composerDrafts.subscribe(listener);
  return () => {
    unsubscribeThreads();
    unsubscribeDrafts();
  };
}

/** A derived snapshot only: no saved status or parallel archive policy. */
export function useArchiveBlockReasons(keys: readonly string[]) {
  const read = () =>
    JSON.stringify(keys.map((key) => [key, threads.archiveBlockReason(key)]));
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return new Map<string, ArchiveBlockReason>(JSON.parse(snapshot));
}
