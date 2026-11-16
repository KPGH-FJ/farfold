import { useEffect, useRef, type MutableRefObject } from "react";
import type { ComposerDraft } from "../runtime/drafts";
import type { PromptBlock } from "../runtime/sessions";
import { folderSendSignature } from "./useDraftArchiveGuard";

export interface DraftSendIntent {
  from: string;
  to: string | null;
  content: string;
}

/** A first send waits for the same draft's explicit preparation exactly once. */
export function useDraftSendIntent(view: {
  pending: MutableRefObject<DraftSendIntent | null>;
  pair: string;
  cwd: string | null;
  active: boolean;
  ready: boolean;
  error: boolean;
  draft: ComposerDraft;
  requireCurrent: () => void;
  retireLocation: () => void;
  prepare: () => void;
  send: (
    blocks: PromptBlock[],
    submitted: ComposerDraft,
  ) => Promise<void | false>;
  pickProject: () => Promise<boolean>;
  requestSend: () => void;
  folderCancelled: (value: boolean) => void;
}) {
  const {
    pending,
    pair,
    cwd,
    active,
    ready,
    error,
    draft,
    requireCurrent,
    requestSend,
    folderCancelled,
  } = view;
  const latest = useRef(view);
  latest.current = view;
  const signature = folderSendSignature(draft);
  if (!active) pending.current = null;
  useEffect(() => {
    const armed = pending.current;
    if (!armed) return;
    if (armed.to === null) {
      if (pair === armed.from) return;
      if (cwd !== null) armed.to = pair;
      else pending.current = null;
      return;
    }
    if (armed.to !== pair) pending.current = null;
  }, [pending, pair, cwd]);
  useEffect(() => {
    if (pending.current && pending.current.content !== signature)
      pending.current = null;
  }, [pending, signature]);
  useEffect(() => {
    if (error) pending.current = null;
  }, [pending, error]);
  useEffect(() => {
    folderCancelled(false);
  }, [pair, signature]);
  useEffect(() => {
    const armed = pending.current;
    if (!active || !armed?.to || armed.to !== pair || !ready) return;
    pending.current = null;
    requestSend();
  }, [pending, active, ready, pair]);

  return async (
    blocks: PromptBlock[],
    submitted: ComposerDraft,
  ): Promise<boolean> => {
    // The original owner must still be current; never forward to a new pair.
    requireCurrent();
    const current = latest.current;
    current.requireCurrent();
    current.retireLocation();
    pending.current = null;
    if (current.cwd && current.ready)
      return (await current.send(blocks, submitted)) !== false;
    const armed = {
      from: pair,
      to: current.cwd ? pair : null,
      content: folderSendSignature(current.draft),
    };
    pending.current = armed;
    current.prepare();
    if (current.cwd) return false;
    const picked = await current.pickProject();
    if (!picked && pending.current === armed && armed.to === null) {
      pending.current = null;
      current.folderCancelled(true);
    }
    // Nothing was sent: keep the original input while waiting or after cancel.
    return false;
  };
}
