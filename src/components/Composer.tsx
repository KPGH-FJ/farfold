import { useProjectFiles } from "./useProjectFiles";
import { ProjectFileScanNotice } from "./ProjectFileScanNotice";
import { useComposerFileDrop } from "./useComposerFileDrop";
import { FILE_DROP_STRINGS } from "../runtime/composer_file_drop";
import { DocumentComposerAttachments } from "./DocumentComposerAttachments";
import { ThreadUsage } from "./ThreadUsage";
import {
  ComposerTemplateActions,
  isCurrentTemplateText,
} from "./ComposerTemplateActions";
import { PromptTemplatesDialog } from "./PromptTemplatesDialog";
import { usePromptTemplates } from "../runtime/prompt_templates";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { projectFileUri } from "../runtime/file_paths";
import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { SENDING_STRINGS as SEND } from "../runtime/sending_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { DangerConfirmDialog } from "./DangerConfirm";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import {
  queueEditorKey,
  queueEditorTarget,
  startQueueEditor,
  keepQueueEditAsDraft,
} from "../runtime/queue_edit";
import { configCheckMessage } from "../runtime/config_check";
import { toUiNotice, uiError, type UiNotice } from "../runtime/ui_error";
import { ErrorNotice } from "./ErrorNotice";
import { ComposerWorkNotice } from "./ComposerWorkNotice";
import { traceAfterPaint } from "../runtime/performance-trace";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpIcon,
  CommandIcon,
  FileTextIcon,
  PaperclipIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import {
  commandInputHint,
  filterComposerActions,
  filterFiles,
  mentionAnchor,
  mentionQuery,
  slashQuery,
} from "../runtime/commands";
import {
  basename,
  threads,
  type PromptBlock,
  type ThreadState,
} from "../runtime/sessions";
import { useWorkPolicy } from "../runtime/work_policy";
import { STRINGS } from "../runtime/strings";
import { hasPendingRequests } from "../runtime/session_types";
import { canReleaseEmptyQueuePause } from "../runtime/queue";
import { LIBRARY } from "../runtime/library_strings";
import { abandonPendingConversation } from "../runtime/pending_conversation";

import {
  composerDrafts,
  useComposerDraft,
  type DraftAttachment,
  type PendingConversation,
  type ComposerDraft,
} from "../runtime/drafts";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
} from "../runtime/draft_attachments";
import {
  addClipboardImages,
  addPickedAttachments,
} from "../runtime/composer_attachment_import";
import { IMAGE_INPUT_STRINGS } from "../runtime/draft_images";
import { queuedAttachmentsNeedReview } from "../runtime/recovered_attachments";
import { AttachmentRecovery } from "./AttachmentRecovery";
import {
  draftPersistence,
  DRAFT_STRINGS,
  useDraftSaveStatus,
} from "../runtime/draft_storage";

export function Composer({
  thread,
  imageEnabled,
  embedContext = false,
  onGoSettings,
  onSend,
  onRecoverPending,
  autofocus = true,
  active = true,
  disabled: disabledProp = false,
  note,
  noteAction = false,
  suppressThreadOpenError = false,
  fit = false,
  draftKey,
  errorContextKey,
  controls,
  attachmentControls,
  editableWhenDisabled = false,
  prepareAction,
  onRequireFolder,
  sendRequest,
  placeholder,
  workContext,
  workLocation,
  caption,
  contextChips,
  queueEditing = false,
  sendActionLabel,
}: {
  thread: ThreadState | null;
  imageEnabled: boolean;
  /** `promptCapabilities.embeddedContext` — `@` picks embed file text. */
  embedContext?: boolean;
  onGoSettings: () => void;
  /** When provided, the composer drives a not-yet-open conversation
   *  (start page). Otherwise it sends into `thread`. */
  onSend?: (
    blocks: PromptBlock[],
    submitted: ComposerDraft,
  ) => void | boolean | Promise<void | boolean>;
  onRecoverPending?: (target: PendingConversation) => Promise<void>;
  autofocus?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** Extra note shown above the box (start-page errors/hints). */
  note?: string | UiNotice | null;
  /** Whether the note gets a「去设置」link (errors — not selection hints). */
  noteAction?: boolean;
  /** The parent already presents this thread's failed-open reason and action. */
  suppressThreadOpenError?: boolean;
  /** Fill its parent column (start page) instead of the 680px measure. */
  fit?: boolean;
  draftKey?: string;
  /** User-selected context, independent from a replacement prepared thread. */
  errorContextKey?: string;
  controls?: ReactNode;
  attachmentControls?: ReactNode;
  editableWhenDisabled?: boolean;
  prepareAction?: () => void;
  /** Invoked when a file action needs a working folder that is not set. */
  onRequireFolder?: () => void | Promise<unknown>;
  /** One-shot send trigger: each new value runs the send path once when
   *  `canSend`; requests that arrive while it cannot send are dropped. */
  sendRequest?: number;
  placeholder?: string;
  workContext?: { agentId: string; cwd: string };
  /** Diagnostic location even before an Agent is selected; not a work grant. */
  workLocation?: string | null;
  caption?: ReactNode;
  contextChips?: ReactNode;
  queueEditing?: boolean;
  sendActionLabel?: string;
}) {
  const storageKey = draftKey ?? (thread ? `session:${thread.key}` : "new");
  const errorContext = errorContextKey ?? storageKey;
  const input = useComposerDraft(storageKey);
  const editingKey = queueEditorKey(thread?.key ?? "");
  const editingDraft = useComposerDraft(editingKey);
  const [queueEditOpen, setQueueEditOpen] = useState(
    Boolean(editingDraft.queueEdit),
  );
  const draftSave = useDraftSaveStatus();
  const { text, attachments: chips } = input;
  const setText = (value: string | ((text: string) => string)) => {
    composerDrafts.update(storageKey, (draft) => ({
      ...draft,
      text: typeof value === "function" ? value(draft.text) : value,
    }));
  };
  const setChips = (
    value:
      DraftAttachment[] | ((items: DraftAttachment[]) => DraftAttachment[]),
  ) => {
    composerDrafts.update(storageKey, (draft) => ({
      ...draft,
      attachments:
        typeof value === "function" ? value(draft.attachments) : value,
    }));
  };
  const [focus, setFocus] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

  const plusAnchor = useRef<HTMLButtonElement>(null);
  const plusOwner = useRef<string | null>(null);
  plusOwner.current = active && plusOpen ? storageKey : null;
  const [commandQuery, setCommandQuery] = useState("");
  const [shortcutScope, setShortcutScope] = useState<string | null>(null);
  const [templateManager, setTemplateManager] = useState(false);
  const templates = usePromptTemplates();
  const shortcutAnchor = useRef<HTMLButtonElement>(null);
  const shortcutOwner = useRef<string | null>(null);
  const shortcutOpen = active && shortcutScope === storageKey;
  shortcutOwner.current = shortcutOpen ? storageKey : null;
  const [sendError, setSendError] = useState<UiNotice | null>(null);
  const [recoveringPending, setRecoveringPending] = useState(false);
  const [abandonPending, setAbandonPending] =
    useState<PendingConversation | null>(null);
  const [uncertainReview, setUncertainReview] = useState<{
    key: string;
    blocks: PromptBlock[];
  } | null>(null);
  const [uncertainError, setUncertainError] = useState<string | null>(null);
  // `@` mention picker: anchor = index of the triggering `@` in `text`;
  // query is the text after it (closes on whitespace or deletion).
  const [mentionAt, setMentionAt] = useState(-1);
  const [dismissedSuggestion, setDismissedSuggestion] = useState<{
    key: string;
    text: string;
  } | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);
  const liveKey = useRef(storageKey);
  liveKey.current = storageKey;
  const liveErrorContext = useRef(errorContext);
  liveErrorContext.current = errorContext;
  useEffect(() => {
    setPlusOpen(false);
    setShortcutScope(null);
    setCommandQuery("");
    setUncertainReview(null);
    setUncertainError(null);
    setMentionAt(-1);
    setDismissedSuggestion(null);
    if (!composerDrafts.read(storageKey).sendPending) busy.current = false;
    setQueueEditOpen(
      Boolean(composerDrafts.read(queueEditorKey(thread?.key ?? "")).queueEdit),
    );
  }, [storageKey, thread?.key]);
  useEffect(() => {
    setSendError(null);
  }, [errorContext]);
  useEffect(() => {
    if (!active) {
      setPlusOpen(false);
      setShortcutScope(null);
      setMentionAt(-1);
      setUncertainReview(null);
    }
  }, [active]);
  useEffect(() => {
    const el = areaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [text, storageKey]);

  const workCwd = thread?.cwd ?? workContext?.cwd ?? null;
  const workAgentId = thread?.agentId ?? workContext?.agentId ?? null;
  const work = useWorkPolicy(workCwd);
  const running = thread?.running ?? false;
  const stopPending = Boolean(
    thread?.stopping ||
    thread?.stopUnconfirmed ||
    thread?.connectionOutcomeUnknown,
  );
  const showStop = !queueEditing && (running || stopPending);
  const stopLabel = thread?.stopping
    ? STRINGS.repair.stopping
    : thread?.stopUnconfirmed
      ? STRINGS.repair.retryStop
      : STRINGS.composer.stopTitle;
  const queued = thread?.queued ?? [];
  const willQueue =
    !queueEditing &&
    Boolean(
      running ||
      (thread && hasPendingRequests(thread)) ||
      (thread?.queuePaused && !canReleaseEmptyQueuePause(thread)) ||
      queued.length,
    );
  const sendLabel = queueEditing
    ? C.saveQueued
    : willQueue
      ? C.addQueued
      : STRINGS.composer.sendTitle;
  const disabled =
    disabledProp ||
    (thread
      ? thread.openError !== null ||
        thread.reconnecting ||
        thread.configuring ||
        Boolean(thread.configError) ||
        thread.modelDrift ||
        Boolean(
          thread.permissionConfigId && thread.permissionState !== "ready",
        ) ||
        !work.enabled(thread.agentId)
      : false);
  const inputDisabled = disabled && !editableWhenDisabled;
  const dropBox = useRef<HTMLDivElement | null>(null);
  const fileDrop = useComposerFileDrop({
    box: dropBox,
    key: storageKey,
    blocked: () => busy.current,
    enabled:
      active &&
      !inputDisabled &&
      !input.sendPending &&
      !draftSave.interactionLocked,
    add: (owner, paths) => {
      void addPickedAttachments(owner, paths, imageEnabled, (message) => {
        if (liveKey.current === owner) setSendError({ message });
      }).catch(() => {
        if (liveKey.current === owner)
          setSendError({ message: STRINGS.repair.requestFailed });
      });
    },
  });

  const autogrow = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  // Slash popup: whole input is a single `/token` and the agent declared
  // commands. Mention popup: live query after the `@` anchor.
  const commands = thread?.availableCommands ?? [];
  const commandNeedle = commandQuery.trim().toLocaleLowerCase();
  const searchedCommands = commands.filter((command) =>
    `${command.name} ${command.description ?? ""}`
      .toLocaleLowerCase()
      .includes(commandNeedle),
  );
  const searchedTemplates = C.shortcuts.filter((item) =>
    `${item.label} ${item.text}`.toLocaleLowerCase().includes(commandNeedle),
  );
  const savedTemplates =
    templates.ready && !templates.uncertain ? templates.items : [];
  const searchedSavedTemplates = savedTemplates.filter((item) =>
    `${item.label} ${item.text}`.toLocaleLowerCase().includes(commandNeedle),
  );
  const liveTemplates = useRef<readonly { label: string; text: string }[]>([]);
  liveTemplates.current = [...C.shortcuts, ...savedTemplates];
  const inputHint = commandInputHint(commands, text);
  const liveCommands = useRef(commands);
  liveCommands.current = commands;
  const suggestionsDismissed =
    dismissedSuggestion?.key === storageKey &&
    dismissedSuggestion.text === text;
  const slashQ = slashQuery(text);
  // W3-7：斜杠菜单与快捷指令面板共用同一分组列表（Agent 命令 + 模板）。
  const slashActions =
    slashQ === null
      ? []
      : filterComposerActions(commands, liveTemplates.current, slashQ);
  const slashOpen =
    !shortcutOpen && !suggestionsDismissed && slashActions.length > 0;
  const slashList = slashActions;
  const mentionQ = mentionAt >= 0 ? mentionQuery(text, mentionAt) : null;
  const mentionOpen =
    !inputDisabled &&
    !shortcutOpen &&
    !suggestionsDismissed &&
    mentionQ !== null;
  const browserSuggestionsReady = useBrowserSurfaceBarrier(
    active && (slashOpen || mentionOpen),
  );
  const cwd = workCwd;
  const fileScan = useProjectFiles(
    storageKey,
    cwd,
    active && mentionOpen && !inputDisabled,
  );
  const currentFiles = fileScan.state;
  const matchingFiles = mentionOpen
    ? filterFiles(currentFiles?.paths ?? [], mentionQ, 51)
    : [];
  const fileList = matchingFiles.slice(0, 50);
  const pickListLen = slashOpen ? slashActions.length : fileList.length;
  const filePickerMounted = useRef(true);
  const filePickerOwner = useRef({
    key: storageKey,
    cwd,
    active,
    inputDisabled,
    files: currentFiles,
    text,
    mentionAt,
  });
  filePickerOwner.current = {
    key: storageKey,
    cwd,
    active,
    inputDisabled,
    files: currentFiles,
    text,
    mentionAt,
  };
  useEffect(() => {
    filePickerMounted.current = true;
    return () => {
      filePickerMounted.current = false;
    };
  }, []);

  useEffect(() => setPickIndex(0), [slashQ, mentionQ, currentFiles?.requestId]);

  // `@` file search asks for a working folder first when none is chosen.
  // Once per mention session; a cancelled choice simply does nothing.
  const folderAsked = useRef(false);
  useEffect(() => {
    if (!mentionOpen) {
      folderAsked.current = false;
      return;
    }
    if (cwd || folderAsked.current) return;
    folderAsked.current = true;
    void onRequireFolder?.();
  }, [mentionOpen, cwd, onRequireFolder]);

  const pickSlash = (index: number) => {
    const action = slashActions[index];
    if (
      !action ||
      !active ||
      inputDisabled ||
      liveKey.current !== storageKey ||
      composerDrafts.read(storageKey).text !== text ||
      draftPersistence.snapshot().interactionLocked
    )
      return;
    if (action.kind === "template" && !isCurrentTemplateText(action.insert))
      return;
    if (
      action.kind === "command" &&
      !liveCommands.current.some((item) => item.name === action.insert)
    )
      return;
    // The whole input is a single `/token`; a pick replaces it entirely —
    // commands keep their `/name ` form, templates insert their body.
    setText(action.kind === "command" ? `/${action.insert} ` : action.insert);
    areaRef.current?.focus();
    requestAnimationFrame(autogrow);
  };

  const pickFile = (index: number) => {
    const owner = filePickerOwner.current;
    if (
      !filePickerMounted.current ||
      !owner.active ||
      owner.inputDisabled ||
      owner.key !== storageKey ||
      owner.cwd !== cwd ||
      owner.files !== currentFiles ||
      owner.text !== text ||
      owner.mentionAt !== mentionAt ||
      !currentFiles ||
      !mentionOpen
    )
      return;
    const rel = fileList[index];
    if (!rel || !cwd || inputDisabled) return;
    let uri: string;
    try {
      uri = projectFileUri(cwd, rel);
    } catch {
      setSendError({ message: STRINGS.repair.requestFailed });
      return;
    }
    const id = crypto.randomUUID();
    setChips((prev) => [
      ...prev,
      {
        id,
        kind: "file" as const,
        name: basename(rel),
        uri,
        loading: embedContext,
      },
    ]);
    if (embedContext) {
      // Agents that accept embedded context get the file text, not just a
      // link — read failures degrade to the link, never block the pick.
      invoke<string>("project_file_read", { cwd, path: rel })
        .then((content) =>
          setChips((prev) =>
            prev.map((chip) =>
              chip.id === id && chip.uri === uri
                ? { ...chip, content, loading: false }
                : chip,
            ),
          ),
        )
        .catch(() =>
          setChips((prev) =>
            prev.map((chip) =>
              chip.id === id && chip.uri === uri
                ? { ...chip, loading: false }
                : chip,
            ),
          ),
        );
    }
    setText((prev) => prev.slice(0, mentionAt));
    setMentionAt(-1);
    areaRef.current?.focus();
    requestAnimationFrame(autogrow);
  };

  const unsupportedImages =
    !imageEnabled && chips.some((chip) => chip.kind === "image");
  const canSend =
    Boolean(text.trim() || chips.length > 0) &&
    active &&
    !disabled &&
    !stopPending &&
    !thread?.submitting &&
    !input.sendPending &&
    !input.pendingConversation &&
    !chips.some((chip) => chip.recovered) &&
    !unsupportedImages &&
    !chips.some((chip) => chip.loading);
  useEffect(() => {
    if (inputDisabled) setShortcutScope(null);
  }, [inputDisabled]);
  const insertShortcut = (value: string) => {
    if (inputDisabled || shortcutOwner.current !== storageKey) return;
    if (
      draftPersistence.snapshot().interactionLocked ||
      busy.current ||
      !isCurrentTemplateText(value)
    )
      return;
    setText(
      (previous) =>
        `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${value}`,
    );
    setShortcutScope(null);
    setMentionAt(-1);
    areaRef.current?.focus();
  };
  // Same staleness guards as templates: a menu left open across a
  // conversation switch must never write into the other draft (W3-7).
  const insertCommand = (name: string) => {
    if (inputDisabled || shortcutOwner.current !== storageKey) return;
    if (!liveCommands.current.some((item) => item.name === name)) return;
    setText((previous) => `/${name} ${previous}`);
    setShortcutScope(null);
    setMentionAt(-1);
    areaRef.current?.focus();
  };
  const ownsAddMenu = () => !inputDisabled && plusOwner.current === storageKey;
  const findProjectFile = () => {
    if (!ownsAddMenu()) return;
    if (!cwd) {
      void onRequireFolder?.();
      return;
    }
    const next = `${text}${text && !/\s$/.test(text) ? " " : ""}@`;
    setText(next);
    setMentionAt(next.length - 1);
    setPlusOpen(false);
    areaRef.current?.focus();
  };

  const doSend = async () => {
    if (!canSend || busy.current) return;
    busy.current = true;
    setSendError(null);
    setPlusOpen(false);
    setMentionAt(-1);
    let submitted = input;
    const targetKey = storageKey;
    const targetErrorContext = errorContext;
    try {
      await draftPersistence.flush();
      const prepared = await prepareDraftAttachments(
        submitted.attachments,
        embedContext,
      );
      const payload = attachmentPromptBlocks(text, prepared, embedContext);
      if (composerDrafts.read(targetKey) !== submitted) return;
      // A stop may arrive while attachments or the draft are being saved.
      // Keep that input in place rather than silently adding it to the queue.
      if (
        thread?.stopping ||
        thread?.stopUnconfirmed ||
        thread?.connectionOutcomeUnknown
      )
        return;
      if (!queueEditing)
        composerDrafts.update(targetKey, (draft) => ({
          ...draft,
          sendPending: true,
        }));
      submitted = composerDrafts.read(targetKey);
      await draftPersistence.flush();
      let sent: void | boolean = true;
      if (onSend) {
        sent = await onSend(payload, submitted);
      } else if (thread) {
        await threads.send(thread.key, payload);
      }
      // `false` means the send did not happen (e.g. waiting on a folder
      // choice): keep the draft instead of treating it as delivered.
      if (sent !== false) composerDrafts.clearIfUnchanged(targetKey, submitted);
      if (
        composerDrafts.read(targetKey).sendPending &&
        !composerDrafts.read(targetKey).pendingConversation
      )
        composerDrafts.update(targetKey, (draft) => ({
          ...draft,
          sendPending: false,
        }));
      await draftPersistence.flush();
      requestAnimationFrame(autogrow);
    } catch (error) {
      if (
        composerDrafts.read(targetKey).sendPending &&
        !composerDrafts.read(targetKey).pendingConversation
      )
        composerDrafts.update(targetKey, (draft) => ({
          ...draft,
          sendPending: false,
        }));
      if (
        liveKey.current === targetKey &&
        liveErrorContext.current === targetErrorContext
      )
        setSendError(toUiNotice(error, STRINGS.repair.sendFailed));
    } finally {
      if (liveKey.current === targetKey) busy.current = false;
    }
  };
  const handledSendRequest = useRef(sendRequest);
  useEffect(() => {
    if (sendRequest === undefined || sendRequest === handledSendRequest.current)
      return;
    handledSendRequest.current = sendRequest;
    if (canSend) void doSend();
  }, [sendRequest, canSend]);

  const pickFiles = async () => {
    const generation = composerDrafts.generation(storageKey);
    let picked: string | string[] | null;
    try {
      picked = await openDialog({ multiple: true });
    } catch (error) {
      if (liveKey.current === storageKey)
        setSendError(toUiNotice(error, STRINGS.repair.requestFailed));
      return;
    }
    if (!picked || composerDrafts.generation(storageKey) !== generation) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    try {
      await addPickedAttachments(storageKey, paths, imageEnabled, (message) => {
        if (liveKey.current === storageKey) setSendError({ message });
      });
    } catch {
      if (liveKey.current === storageKey)
        setSendError({ message: STRINGS.repair.requestFailed });
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0 || inputDisabled) return;
    if (!imageEnabled) {
      e.preventDefault();
      setSendError({ message: IMAGE_INPUT_STRINGS.noImageInput });
      return;
    }
    e.preventDefault();
    void addClipboardImages(storageKey, files, (message) => {
      if (liveKey.current === storageKey) setSendError({ message });
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    traceAfterPaint("input_paint");
    const value = e.target.value;
    // 「@」在开头或空白后 → 打开项目文件选择（picker 读光标前的
    // 子串做模糊匹配；选中后整段 `@query` 从文本中移除换成 chip）。
    const at = mentionAnchor(value);
    if (at >= 0) setMentionAt(at);
    setDismissedSuggestion(null);
    setText(value);
    autogrow();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Legacy WebKit can dispatch compositionend before its confirming keydown;
    // that key still reports 229 even though isComposing has already cleared.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (slashOpen || mentionOpen) {
      if (e.key === "Tab" && mentionOpen) {
        if (!e.shiftKey) {
          const button = fileMenuRef.current?.querySelector<HTMLButtonElement>(
            "button:not(:disabled)",
          );
          if (button) {
            e.preventDefault();
            button.focus();
          }
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPickIndex(
          (prev) =>
            (prev +
              (e.key === "ArrowDown" ? 1 : -1) +
              Math.max(pickListLen, 1)) %
            Math.max(pickListLen, 1),
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        if (slashOpen) pickSlash(pickIndex);
        else pickFile(pickIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedSuggestion({ key: storageKey, text });
        setMentionAt(-1);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (prepareAction && disabled && (text.trim() || chips.length))
      prepareAction();
    else void doSend();
  };

  const permissionNote =
    thread?.permissionConfigId && thread.permissionState !== "ready"
      ? thread.permissionState === "changing"
        ? C.permissionChanging
        : thread.permissionState === "unknown"
          ? C.permissionUnknownNote
          : C.permissionRequiredNote
      : null;
  const noteMessage = typeof note === "string" ? note : (note?.message ?? null);
  const noteDetail = note && typeof note === "object" ? note.detail : undefined;
  const notes: [string | null | undefined, boolean, string?][] = [
    [permissionNote, false],
    [unsupportedImages ? W.imageUnsupported : null, false],
    [suppressThreadOpenError ? null : thread?.openError, true],
    [thread?.configError, false],
    [sendError?.message, false, sendError?.detail],
    [
      !queueEditing && workAgentId && work.ready && !work.enabled(workAgentId)
        ? STRINGS.repair.workOff
        : null,
      false,
    ],
    [work.error, false],
    [
      thread?.modelDrift
        ? (configCheckMessage(thread.configCheck, thread.configOptions) ??
          STRINGS.repair.modelDrifted)
        : null,
      false,
    ],
    [noteMessage, noteAction, noteDetail],
  ];
  const [openNote, showAction, openNoteDetail] = notes.find(([text]) =>
    Boolean(text),
  ) ?? [null, false];
  const uncertainCurrent =
    uncertainReview &&
    thread?.key === uncertainReview.key &&
    thread.uncertainPrompt === uncertainReview.blocks &&
    !thread.submitting &&
    thread.queued.includes(uncertainReview.blocks);
  const abandonUncertain = (keep: boolean) => {
    if (!uncertainReview || !uncertainCurrent) return;
    try {
      threads.abandonUncertainPrompt(
        uncertainReview.key,
        uncertainReview.blocks,
        keep,
      );
      setUncertainReview(null);
      setUncertainError(null);
    } catch (reason) {
      setUncertainError(uiError(reason, STRINGS.repair.uncertainChanged));
    }
  };
  const addContents = (
    <div className="composer-add-list">
      <button
        type="button"
        onClick={() => {
          if (!ownsAddMenu()) return;
          setPlusOpen(false);
          void pickFiles();
        }}
      >
        <PaperclipIcon size={19} />
        <span>
          <strong>{STRINGS.composer.addFile}</strong>
        </span>
      </button>
      {thread?.identity === "established" && (
        <button type="button" onClick={findProjectFile}>
          <FileTextIcon size={19} />
          <span>
            <strong>{C.findProjectFile}</strong>
            <small>{C.findProjectFileHint}</small>
          </span>
        </button>
      )}
      {attachmentControls}
    </div>
  );

  return (
    <div
      className={`composer${fit ? " fit" : ""}`}
      onKeyDown={(event) => {
        // Portal events bubble here too, including events on the menu panel.
        if (shortcutOpen || plusOpen) event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (
          plusOpen &&
          event.key === "Escape" &&
          event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <AttachmentRecovery
        draftKey={storageKey}
        thread={queueEditing ? null : thread}
        embed={embedContext}
        active={active}
      />
      {draftSave.error && (
        <ErrorNotice message={draftSave.error}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void draftPersistence.flush().catch(() => undefined)}
          >
            {DRAFT_STRINGS.retry}
          </button>
        </ErrorNotice>
      )}
      {(input.sendPending || input.pendingConversation) && !busy.current && (
        <div className="auth-note" role="alert">
          <span>{DRAFT_STRINGS.uncertain}</span>
          {input.pendingConversation && onRecoverPending ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={recoveringPending}
                onClick={() => {
                  const target = input.pendingConversation!;
                  setRecoveringPending(true);
                  setSendError(null);
                  void onRecoverPending(target)
                    .catch((error) => {
                      if (liveKey.current === storageKey)
                        setSendError(
                          toUiNotice(error, STRINGS.repair.reconnectFailed),
                        );
                    })
                    .finally(() => setRecoveringPending(false));
                }}
              >
                {recoveringPending
                  ? DRAFT_STRINGS.openingPending
                  : DRAFT_STRINGS.openPending}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={recoveringPending}
                onClick={() => setAbandonPending(input.pendingConversation!)}
              >
                {DRAFT_STRINGS.abandonPending}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                composerDrafts.update(storageKey, (draft) => ({
                  ...draft,
                  sendPending: false,
                }))
              }
            >
              {DRAFT_STRINGS.reviewed}
            </button>
          )}
        </div>
      )}
      {abandonPending && (
        <DangerConfirmDialog
          title={DRAFT_STRINGS.abandonPending}
          confirmLabel={DRAFT_STRINGS.abandonPending}
          onConfirm={() => {
            abandonPendingConversation(storageKey, abandonPending);
            setAbandonPending(null);
          }}
          cancelLabel={LIBRARY.cancel}
          onCancel={() => setAbandonPending(null)}
        >
          <p>{DRAFT_STRINGS.abandonPendingNote}</p>
        </DangerConfirmDialog>
      )}
      {thread && editingDraft.queueEdit && (
        <div className="auth-note">
          <span>{C.queueEditHint}</span>
          <button
            type="button"
            className="btn btn-text"
            onClick={() => setQueueEditOpen(true)}
          >
            {C.resumeQueuedEdit}
          </button>
        </div>
      )}
      {thread && queueEditOpen && editingDraft.queueEdit && (
        <WorkspaceDialog
          title={C.editQueued}
          onClose={() => setQueueEditOpen(false)}
        >
          <Composer
            thread={null}
            draftKey={editingKey}
            queueEditing
            imageEnabled={imageEnabled}
            embedContext={embedContext}
            onGoSettings={onGoSettings}
            disabled={!queueEditorTarget(editingDraft, queued)}
            editableWhenDisabled
            onSend={async (replacement, submitted) => {
              if (
                composerDrafts.read(editingKey).queueEdit !==
                submitted.queueEdit
              )
                throw new Error(C.queueEditStale);
              const original = queueEditorTarget(submitted, thread.queued);
              if (!original) throw new Error(C.queueEditStale);
              threads.replaceQueued(thread.key, original, replacement);
              setQueueEditOpen(false);
            }}
          />
          {!queueEditorTarget(editingDraft, queued) && (
            <p role="alert">{C.queueEditStale}</p>
          )}
          <div className="workspace-dialog-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                composerDrafts.clear(editingKey);
                setQueueEditOpen(false);
              }}
            >
              {C.discardQueueEdit}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                keepQueueEditAsDraft(thread.key);
                setQueueEditOpen(false);
              }}
            >
              {C.keepAsDraft}
            </button>
          </div>
        </WorkspaceDialog>
      )}
      {queued.map((blocksOfOne, i) => {
        const preview = blocksOfOne
          .map((b) =>
            b.type === "text"
              ? b.text
              : b.type === "image"
                ? STRINGS.composer.imageChip
                : `[${b.type === "resource" ? basename(b.resource.uri) : b.name}]`,
          )
          .join(" ")
          .slice(0, 60);
        return (
          <div key={i} className="queued">
            <span className="q-tag">{STRINGS.composer.queued(i + 1)}</span>
            <span>{preview}</span>
            {thread && (
              <>
                {blocksOfOne === thread.uncertainPrompt && (
                  <button
                    type="button"
                    className="btn btn-text"
                    disabled={thread.submitting}
                    onClick={() => {
                      setUncertainError(null);
                      setUncertainReview({
                        key: thread.key,
                        blocks: blocksOfOne,
                      });
                    }}
                  >
                    {STRINGS.repair.reviewUncertain}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-text"
                  disabled={
                    Boolean(editingDraft.queueEdit) ||
                    blocksOfOne === thread.uncertainPrompt ||
                    (thread.submitting && i === 0)
                  }
                  onClick={() => {
                    try {
                      const original = threads.beginQueueEdit(thread.key, i);
                      startQueueEditor(thread.key, i, original);
                      setQueueEditOpen(true);
                    } catch (reason) {
                      setSendError(
                        toUiNotice(reason, STRINGS.repair.requestFailed),
                      );
                    }
                  }}
                >
                  {C.editQueued}
                </button>
                <button
                  type="button"
                  aria-label={W.removeQueued}
                  disabled={
                    Boolean(editingDraft.queueEdit) ||
                    blocksOfOne === thread.uncertainPrompt ||
                    (thread.submitting && i === 0)
                  }
                  className="q-x"
                  onClick={() => threads.dequeue(thread.key, i)}
                >
                  ×
                </button>
              </>
            )}
          </div>
        );
      })}
      {active && uncertainReview && thread?.key === uncertainReview.key && (
        <WorkspaceDialog
          title={STRINGS.repair.uncertainTitle}
          onClose={() => setUncertainReview(null)}
        >
          <div className="workspace-dialog-body">
            <p>{STRINGS.repair.uncertainNote}</p>
            <div className="uncertain-prompt-preview">
              {uncertainReview.blocks.map((block, index) =>
                block.type === "text" ? (
                  <pre key={index}>{block.text}</pre>
                ) : (
                  <p key={index}>
                    {block.type === "image"
                      ? STRINGS.composer.imageChip
                      : block.type === "resource"
                        ? basename(block.resource.uri)
                        : block.name}
                  </p>
                ),
              )}
            </div>
            {(!uncertainCurrent || uncertainError) && (
              <p role="alert">
                {uncertainError ?? STRINGS.repair.uncertainChanged}
              </p>
            )}
          </div>
          <footer>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!uncertainCurrent}
              onClick={() => abandonUncertain(true)}
            >
              {STRINGS.repair.uncertainKeep}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!uncertainCurrent}
              onClick={() => abandonUncertain(false)}
            >
              {STRINGS.repair.uncertainDiscard}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setUncertainReview(null)}
            >
              {LIBRARY.cancel}
            </button>
          </footer>
        </WorkspaceDialog>
      )}
      {queued.length > 0 && (
        <div className="auth-note" style={{ marginTop: -4 }}>
          <span>
            {thread?.uncertainPrompt
              ? STRINGS.repair.uncertain
              : thread?.connectionOutcomeUnknown
                ? STRINGS.repair.executionUnconfirmed
                : thread?.queuePaused === "no_result"
                  ? STRINGS.repair.noResultQueue
                  : thread?.queuePaused
                    ? STRINGS.repair.queuePaused
                    : STRINGS.composer.queuedTail}
          </span>
          {thread?.queuePaused && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                disabled ||
                thread.running ||
                thread.submitting ||
                thread.stopping ||
                thread.stopUnconfirmed ||
                hasPendingRequests(thread) ||
                !!thread.uncertainPrompt ||
                thread.connectionOutcomeUnknown ||
                thread.queued.some(queuedAttachmentsNeedReview) ||
                Boolean(editingDraft.queueEdit)
              }
              onClick={() => void threads.continueQueue(thread.key)}
            >
              {STRINGS.repair.continueQueue}
            </button>
          )}
        </div>
      )}
      {openNote && (
        <ComposerWorkNotice
          message={openNote}
          detail={openNoteDetail}
          showAction={showAction}
          work={work}
          workAgentId={workAgentId}
          cwd={workCwd ?? workLocation ?? null}
          active={active}
          archiveHandled={suppressThreadOpenError}
          onGoSettings={onGoSettings}
        />
      )}
      {browserSuggestionsReady && slashOpen && (
        <div className="pick-menu" role="listbox">
          {slashActions.map((action, i) => (
            <Fragment key={`${action.kind}:${action.label}:${i}`}>
              {(i === 0 || slashActions[i - 1].kind !== action.kind) && (
                <div className="pm pm-group" aria-hidden="true">
                  {action.kind === "command"
                    ? C.agentCommands
                    : C.templatesGroup}
                </div>
              )}
              <div
                role="option"
                aria-selected={i === pickIndex}
                className={`pm${i === pickIndex ? " on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(i);
                }}
              >
                <span className="pm-name">{action.label}</span>
                {action.detail && (
                  <span className="pm-desc">{action.detail}</span>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}
      {browserSuggestionsReady && mentionOpen && (
        <div className="pick-menu" ref={fileMenuRef}>
          <ProjectFileScanNotice
            state={currentFiles}
            cwd={cwd}
            noMatch={fileList.length === 0}
            matchesLimited={matchingFiles.length > 50}
            onCancel={fileScan.cancel}
            onRetry={fileScan.retry}
            onChoose={() => {
              const owner = filePickerOwner.current;
              if (
                filePickerMounted.current &&
                owner.active &&
                !owner.inputDisabled &&
                owner.key === storageKey &&
                owner.cwd === cwd &&
                owner.text === text &&
                owner.mentionAt === mentionAt
              )
                void pickFiles();
            }}
          />
          <div role="listbox" aria-label={C.findProjectFile}>
            {fileList.map((file, i) => (
              <div
                key={file}
                role="option"
                aria-selected={i === pickIndex}
                className={`pm${i === pickIndex ? " on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickFile(i);
                }}
              >
                <span className="pm-name">{basename(file)}</span>
                <span className="pm-desc">{file}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {stopPending && (
        <div
          className="composer-stop-notice"
          role="status"
          aria-label={C.stopStatus}
        >
          <strong>
            {thread?.stopping
              ? C.stopWaiting
              : thread?.stopUnconfirmed
                ? C.stopUnknown
                : C.executionUnknown}
          </strong>
          <p>
            {thread?.stopping
              ? C.stopWaitingNote
              : thread?.stopUnconfirmed
                ? C.stopUnknownNote
                : STRINGS.repair.executionUnconfirmed}
          </p>
        </div>
      )}
      <div
        ref={dropBox}
        className={`composer-box${focus ? " focus" : ""}${fileDrop.over ? " file-drop-over" : ""}`}
      >
        {fileDrop.over && (
          <p className="composer-file-drop" role="status">
            {FILE_DROP_STRINGS.release}
          </p>
        )}
        {active && fileDrop.error && (
          <p className="composer-command-hint" role="status">
            {fileDrop.error}
          </p>
        )}
        {contextChips}
        <DocumentComposerAttachments
          key={storageKey}
          draftKey={storageKey}
          context={JSON.stringify([errorContext, workAgentId, workCwd])}
          enabled={
            active &&
            !inputDisabled &&
            !busy.current &&
            !input.sendPending &&
            !input.pendingConversation
          }
          items={chips}
          onRemove={(id) =>
            setChips((previous) => previous.filter((chip) => chip.id !== id))
          }
        />
        <textarea
          ref={areaRef}
          className="c-input"
          aria-label={W.inputLabel}
          aria-description={inputHint}
          placeholder={
            placeholder ??
            (running
              ? STRINGS.composer.placeholderRunning
              : thread && thread.identity === "draft"
                ? STRINGS.composer.placeholderFirst
                : STRINGS.composer.placeholder)
          }
          rows={1}
          value={text}
          disabled={inputDisabled}
          autoFocus={autofocus}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
        {inputHint && <p className="composer-command-hint">{inputHint}</p>}
        <div
          className="c-row"
          onKeyDown={(event) => {
            if (event.key === "Escape") setPlusOpen(false);
          }}
        >
          <div className="c-tools">
            <button
              ref={plusAnchor}
              type="button"
              className="icon-btn"
              title={STRINGS.composer.addTitle}
              aria-label={STRINGS.composer.addTitle}
              aria-expanded={plusOpen}
              aria-haspopup="dialog"
              disabled={inputDisabled}
              onClick={() => {
                plusAnchor.current?.focus();
                setPlusOpen((v) => !v);
              }}
            >
              <PlusIcon size={20} />
            </button>
            {controls}
            {thread && !queueEditing && (
              <button
                ref={shortcutAnchor}
                type="button"
                className="icon-btn"
                title={C.commandsTitle}
                aria-label={C.commandsTitle}
                aria-haspopup="dialog"
                aria-expanded={shortcutOpen}
                disabled={!active || inputDisabled}
                onClick={() => {
                  setPlusOpen(false);
                  setShortcutScope(shortcutOpen ? null : storageKey);
                }}
              >
                <CommandIcon size={17} />
              </button>
            )}
          </div>
          <div className="c-actions">
            {showStop && thread && (
              <button
                type="button"
                className={`c-stop${thread.stopUnconfirmed ? " c-stop-retry" : ""}`}
                title={stopLabel}
                aria-label={stopLabel}
                disabled={!active || thread.stopping || thread.connectionLost}
                onClick={() => void threads.cancel(thread.key)}
              >
                <i aria-hidden="true" />
                <span>{stopLabel}</span>
              </button>
            )}
            {prepareAction && disabled && !showStop ? (
              <button
                type="button"
                className="c-prepare"
                onClick={prepareAction}
              >
                {W.prepareAgent}
              </button>
            ) : (
              <button
                type="button"
                className={`c-send${willQueue ? " c-send-queued" : ""}${canSend ? "" : " empty"}`}
                title={
                  !willQueue && sendActionLabel ? sendActionLabel : sendLabel
                }
                aria-label={
                  !willQueue && sendActionLabel ? sendActionLabel : sendLabel
                }
                disabled={!canSend}
                onClick={() => void doSend()}
              >
                <ArrowUpIcon size={19} />
                {willQueue && <span>{C.queuedShort}</span>}
              </button>
            )}
          </div>
        </div>
      </div>
      {shortcutOpen && !inputDisabled && (
        <WorkspaceActionMenu
          anchor={shortcutAnchor.current}
          title={C.commandsTitle}
          onClose={() => setShortcutScope(null)}
        >
          <div className="workspace-action-body composer-shortcuts">
            <input
              type="search"
              aria-label={R.commandSearch}
              placeholder={R.commandSearch}
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
            />
            <p className="composer-shortcuts-note">{R.commandNote}</p>
            {commandNeedle &&
              !searchedCommands.length &&
              !searchedTemplates.length &&
              !searchedSavedTemplates.length && (
                <p role="status">{R.commandEmpty}</p>
              )}
            <span className="composer-shortcuts-title">{C.agentCommands}</span>
            {searchedCommands.map((command) => (
              <button
                key={command.name}
                type="button"
                className="btn btn-ghost"
                onClick={() => insertCommand(command.name)}
              >
                <CommandIcon size={15} />
                <span>/{command.name}</span>
                {command.description && <small>{command.description}</small>}
              </button>
            ))}
            {!commands.length && (
              <p role="status" className="composer-shortcuts-empty">
                {C.agentCommandsEmpty}
              </p>
            )}
            <ComposerTemplateActions
              items={searchedSavedTemplates}
              builtins={searchedTemplates}
              error={!!templates.error}
              onInsert={insertShortcut}
              onManage={() => {
                setShortcutScope(null);
                setTemplateManager(true);
              }}
            />
          </div>
        </WorkspaceActionMenu>
      )}
      {active && templateManager && (
        <PromptTemplatesDialog
          returnFocusRef={shortcutAnchor}
          onClose={() => setTemplateManager(false)}
        />
      )}
      <div className="composer-footer">
        {thread?.identity === "established" && (
          <ThreadUsage key={thread.key} thread={thread} disabled={!active} />
        )}
        {caption && <span className="composer-caption">{caption}</span>}
        <span className="c-hint">
          {queueEditing
            ? C.queueEditHint
            : stopPending
              ? C.stopSendingPaused
              : running
                ? STRINGS.composer.hintQueue
                : sendActionLabel
                  ? R.keyboardAction(sendActionLabel)
                  : W.keyboardSend}
        </span>
      </div>
      {active && plusOpen && (
        <WorkspaceActionMenu
          key="add"
          anchor={plusAnchor.current}
          title={C.addTitle}
          onClose={() => setPlusOpen(false)}
        >
          {addContents}
        </WorkspaceActionMenu>
      )}
    </div>
  );
}
