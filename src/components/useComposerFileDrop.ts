import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { composerDrafts } from "../runtime/drafts";
import { draftPersistence } from "../runtime/draft_storage";
import {
  createFileDropHandler,
  FILE_DROP_STRINGS,
} from "../runtime/composer_file_drop";

export function useComposerFileDrop({
  box,
  key,
  enabled,
  blocked,
  add,
}: {
  box: RefObject<HTMLDivElement | null>;
  key: string;
  enabled: boolean;
  blocked: () => boolean;
  add: (key: string, paths: string[]) => void;
}) {
  const [over, setOver] = useState<{ key: string; generation: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const live = useRef({ key, enabled, blocked, add });
  live.current = { key, enabled, blocked, add };
  useEffect(() => {
    let mounted = true;
    let accepting = true;
    let unlisten: (() => void) | undefined;
    const handler = createFileDropHandler({
      owner: () => ({
        key: live.current.key,
        generation: composerDrafts.generation(live.current.key),
        enabled:
          mounted &&
          live.current.enabled &&
          !live.current.blocked() &&
          !composerDrafts.read(live.current.key).sendPending &&
          !draftPersistence.snapshot().interactionLocked,
      }),
      accepts: ({ x, y }) => {
        const element = box.current;
        const scale = window.devicePixelRatio;
        if (
          !element ||
          element.closest("[inert]") ||
          !Number.isFinite(scale) ||
          scale <= 0
        )
          return false;
        const rect = element.getBoundingClientRect();
        const left = x / scale,
          top = y / scale;
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          left < rect.left ||
          left > rect.right ||
          top < rect.top ||
          top > rect.bottom
        )
          return false;
        const hit = element.ownerDocument.elementFromPoint(left, top);
        return !!hit && element.contains(hit);
      },
      highlight: (value) => {
        if (mounted)
          setOver(
            value
              ? {
                  key: live.current.key,
                  generation: composerDrafts.generation(live.current.key),
                }
              : null,
          );
      },
      add: (owner, paths) => live.current.add(owner, paths),
    });
    void (async () => {
      try {
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (mounted && accepting) handler(event.payload);
        });
        if (!mounted) stop();
        else unlisten = stop;
      } catch {
        // The API may reject after registering only some event listeners.
        // Its partial callbacks must not import after we report unavailable.
        accepting = false;
        if (mounted) setOver(null);
        if (mounted) setError(FILE_DROP_STRINGS.unavailable);
      }
    })();
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [box]);
  return {
    over:
      enabled &&
      over?.key === key &&
      over.generation === composerDrafts.generation(key),
    error,
  };
}
