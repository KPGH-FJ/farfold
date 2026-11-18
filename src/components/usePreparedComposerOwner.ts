import { useEffect, useRef, useState } from "react";
import { DraftLocationOwner } from "../runtime/draft_location_owner";
import {
  composerDrafts,
  newConversationChoice,
  useComposerDraft,
} from "../runtime/drafts";
import { useDraftSaveStatus } from "../runtime/draft_storage";
import type { ThreadState } from "../runtime/session_types";
import { threads } from "../runtime/sessions";
import { captureConfigurationOwner } from "../runtime/saved_configuration_restore";
import type { AgentRepairRequest } from "../runtime/agent_repair";

const selectedSource = () =>
  JSON.stringify([
    newConversationChoice.agentId,
    newConversationChoice.cwd,
    newConversationChoice.service,
  ]);

/** Carries only ownership of the editor's actual completed preparation. */
export function usePreparedComposerOwner(context: string, active: boolean) {
  const owner = useRef(new DraftLocationOwner());
  const latest = useRef({ context, active });
  latest.current = { context, active };
  owner.current.observe(context, active);
  const opened = useRef<{
    key: string;
    context: string;
    state?: ThreadState;
    sameConnection?: () => boolean;
    generation: number;
    selection: string;
  } | null>(null);
  const claim = useRef<{
    key: string;
    token: object | null;
    current: () => boolean;
  } | null>(null);
  useEffect(() => () => owner.current.retire(), []);
  return {
    open(key: string, state?: ThreadState) {
      if (latest.current.context !== context || !latest.current.active) return;
      owner.current.retire();
      opened.current = {
        key,
        context,
        state,
        sameConnection: state ? captureConfigurationOwner(state) : undefined,
        generation: composerDrafts.generation("new"),
        selection: selectedSource(),
      };
      claim.current = null;
    },
    ownsState(state: ThreadState) {
      return (
        opened.current?.state === state &&
        opened.current.sameConnection?.() === true &&
        opened.current.generation === composerDrafts.generation("new") &&
        opened.current.selection === selectedSource() &&
        threads.thread(state.key) === state
      );
    },
    current(key: string | null): (() => boolean) | null {
      if (
        !key ||
        !active ||
        opened.current?.key !== key ||
        opened.current.context !== context ||
        opened.current.generation !== composerDrafts.generation("new") ||
        opened.current.selection !== selectedSource()
      )
        return null;
      if (
        claim.current?.key !== key ||
        !owner.current.owns(claim.current.token)
      ) {
        const token = owner.current.begin();
        const completed = opened.current;
        claim.current = {
          key,
          token,
          current: () =>
            owner.current.owns(token) &&
            latest.current.context === context &&
            opened.current === completed &&
            completed.generation === composerDrafts.generation("new") &&
            completed.selection === selectedSource(),
        };
      }
      return claim.current.current;
    },
  };
}

export type DraftPreparationNavigation = (
  agentId?: string,
  repair?: AgentRepairRequest,
  restoreFocus?: () => void,
) => void;

function visibleFocusTarget(target: Element | null): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    target.isConnected &&
    !target.closest("[hidden], [inert], :disabled") &&
    target.getClientRects().length > 0
  );
}

export function restoreDraftPreparationFocus(
  root: HTMLElement,
  opener: HTMLButtonElement | null,
): void {
  if (!root.isConnected) return;
  const doc = root.ownerDocument;
  const current = doc.activeElement;
  if (
    (current !== doc.body &&
      current !== doc.documentElement &&
      visibleFocusTarget(current)) ||
    doc.querySelector("dialog[open]")
  )
    return;
  const target =
    visibleFocusTarget(opener) && root.contains(opener)
      ? opener
      : root.querySelector("textarea.c-input");
  if (visibleFocusTarget(target)) target.focus({ preventScroll: true });
}

/** Moving the portal does not replace the draft or invalidate file reads. */
export function usePreparedComposerPortal(
  target: HTMLElement | null | undefined,
  active: boolean,
) {
  const [editorRoot] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const editorHome = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const destination = target ?? editorHome.current;
    if (!editorRoot || !destination) return;
    const focused = editorRoot.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    editorRoot.className = "empty-col";
    destination.appendChild(editorRoot);
    if (activeRef.current) focused?.focus({ preventScroll: true });
  }, [editorRoot, target]);
  useEffect(() => () => editorRoot?.remove(), [editorRoot]);
  const captureReturnFocus = (opener: HTMLButtonElement | null) => () => {
    const root = editorRoot ?? editorHome.current;
    if (activeRef.current && root) restoreDraftPreparationFocus(root, opener);
  };
  return { editorRoot, editorHome, captureReturnFocus };
}

/** Persistence can establish a prepared conversation before its first prompt.
 * Move its editor to the normal route; never broaden first-send admission. */
export type PreparedConversationTransition = (
  state: ThreadState,
  move: () => boolean,
) => boolean;
export function useSavedPreparedConversation(
  state: ThreadState | null,
  current: (() => boolean) | null,
  prepared: ReturnType<typeof usePreparedComposerOwner>,
  transition: PreparedConversationTransition | undefined,
  onStarted: (key: string) => void,
) {
  const storage = useDraftSaveStatus();
  const input = useComposerDraft("new");
  const destination = useComposerDraft(state ? `session:${state.key}` : "");
  const latest = useRef({ prepared, transition, onStarted });
  latest.current = { prepared, transition, onStarted };
  useEffect(() => {
    if (
      !state ||
      state.identity !== "established" ||
      state.configuring ||
      state.sessionToolRecoveryRequired ||
      state.uncertainPrompt ||
      state.connectionOutcomeUnknown ||
      state.stopUnconfirmed ||
      !current?.() ||
      !latest.current.prepared.ownsState(state) ||
      !storage.ready ||
      storage.interactionLocked
    )
      return;
    if (
      latest.current.transition?.(
        state,
        () =>
          current() &&
          latest.current.prepared.ownsState(state) &&
          composerDrafts.movePreparedToSession(
            state.key,
            composerDrafts.read("new"),
          ),
      )
    )
      latest.current.onStarted(state.key);
  }, [
    state,
    state?.identity,
    state?.configuring,
    state?.sessionToolRecoveryRequired,
    state?.uncertainPrompt,
    state?.connectionOutcomeUnknown,
    state?.stopUnconfirmed,
    current,
    storage,
    input,
    destination,
    transition,
  ]);
}
