import { filePathUri, projectFileUri } from "../runtime/file_paths";
import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { SENDING_STRINGS as SEND } from "../runtime/sending_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import {
  queueEditorKey,
  queueEditorTarget,
  startQueueEditor,
  keepQueueEditAsDraft,
} from "../runtime/queue_edit";
import { configCheckMessage } from "../runtime/config_check";
/**
 * 消息栏（F 稿 .composer）：自动增高、Enter/Shift+Enter、IME 安全、
 * 粘贴图片（需 promptCapabilities.image）、@ 或 + 添加文件、
 * 运行中排队显示、停止按钮。
 */
import { uiError } from "../runtime/ui_error";
import { traceAfterPaint } from "../runtime/performance-trace";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpIcon,
  CommandIcon,
  FileTextIcon,
  PaperclipIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import {
  commandInputHint,
  filterCommands,
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
import { prepareDraftAttachments } from "../runtime/draft_attachments";
import { queuedAttachmentsNeedReview } from "../runtime/recovered_attachments";
import { AttachmentRecovery } from "./AttachmentRecovery";
import {
  draftPersistence,
  DRAFT_STRINGS,
  useDraftSaveStatus,
} from "../runtime/draft_storage";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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
  placeholder,
  workContext,
  caption,
  contextChips,
  queueEditing = false,
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
  ) => void | Promise<void>;
  onRecoverPending?: (target: PendingConversation) => Promise<void>;
  autofocus?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** Extra note shown above the box (start-page errors/hints). */
  note?: string | null;
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
  placeholder?: string;
  workContext?: { agentId: string; cwd: string };
  caption?: ReactNode;
  contextChips?: ReactNode;
  queueEditing?: boolean;
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
  const [agentCommandsOpen, setAgentCommandsOpen] = useState(false);
  const plusAnchor = useRef<HTMLButtonElement>(null);
  const plusOwner = useRef<string | null>(null);
  plusOwner.current = active && plusOpen ? storageKey : null;
  const [shortcutScope, setShortcutScope] = useState<string | null>(null);
  const shortcutAnchor = useRef<HTMLButtonElement>(null);
  const shortcutOwner = useRef<string | null>(null);
  const shortcutOpen = active && shortcutScope === storageKey;
  shortcutOwner.current = shortcutOpen ? storageKey : null;
  const [sendError, setSendError] = useState<string | null>(null);
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
  const [files, setFiles] = useState<{
    key: string;
    cwd: string;
    paths: string[];
  } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = useRef(false);
  const liveKey = useRef(storageKey);
  liveKey.current = storageKey;
  const liveErrorContext = useRef(errorContext);
  liveErrorContext.current = errorContext;
  useEffect(() => {
    setPlusOpen(false);
    setShortcutScope(null);
    setUncertainReview(null);
    setUncertainError(null);
    setMentionAt(-1);
    setDismissedSuggestion(null);
    setFiles(null);
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
        thread.modelDrift ||
        Boolean(
          thread.permissionConfigId && thread.permissionState !== "ready",
        ) ||
        !work.enabled(thread.agentId)
      : false);
  const inputDisabled = disabled && !editableWhenDisabled;

  const autogrow = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  // Slash popup: whole input is a single `/token` and the agent declared
  // commands. Mention popup: live query after the `@` anchor.
  const commands = thread?.availableCommands ?? [];
  const inputHint = commandInputHint(commands, text);
  const liveCommands = useRef(commands);
  liveCommands.current = commands;
  const suggestionsDismissed =
    dismissedSuggestion?.key === storageKey &&
    dismissedSuggestion.text === text;
  const slashQ = slashQuery(text);
  const slashOpen =
    !shortcutOpen &&
    !suggestionsDismissed &&
    slashQ !== null &&
    commands.length > 0;
  const slashList = slashOpen ? filterCommands(commands, slashQ) : [];
  const mentionQ = mentionAt >= 0 ? mentionQuery(text, mentionAt) : null;
  const mentionOpen =
    !shortcutOpen && !suggestionsDismissed && mentionQ !== null;
  const browserSuggestionsReady = useBrowserSurfaceBarrier(
    active && ((slashOpen && slashList.length > 0) || mentionOpen),
  );
  const cwd = workCwd;
  const currentFiles =
    files?.key === storageKey && files.cwd === cwd ? files : null;
  const fileList = mentionOpen
    ? filterFiles(currentFiles?.paths ?? [], mentionQ)
    : [];
  const pickListLen = slashOpen ? slashList.length : fileList.length;
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

  // The selected folder is available before an Agent connection exists.
  // Never display a prior folder's list while its replacement is loading.
  useEffect(() => {
    if (!active || !mentionOpen || !cwd) return;
    let current = true;
    invoke<{ files: string[] }>("project_files", { cwd })
      .then((result) => {
        if (current) setFiles({ key: storageKey, cwd, paths: result.files });
      })
      .catch(() => {
        if (current) setFiles({ key: storageKey, cwd, paths: [] });
      });
    return () => {
      current = false;
    };
  }, [mentionOpen, cwd, active, storageKey]);

  useEffect(() => setPickIndex(0), [slashQ, mentionQ]);

  const pickSlash = (index: number) => {
    const command = slashList[index];
    if (!command) return;
    setText(`/${command.name} `);
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
      setSendError(STRINGS.repair.requestFailed);
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

  const blocks = (attachments: DraftAttachment[]): PromptBlock[] => {
    const out: PromptBlock[] = [];
    const trimmed = text.trim();
    if (trimmed) out.push({ type: "text", text: trimmed });
    for (const chip of attachments) {
      if (chip.kind === "image" && chip.data) {
        out.push({
          type: "image",
          data: chip.data,
          mimeType: chip.mimeType ?? "image/png",
        });
      } else if (chip.kind === "file" && chip.uri) {
        if (embedContext && chip.content !== undefined) {
          out.push({
            type: "resource",
            resource: {
              uri: chip.uri,
              mimeType: "text/plain",
              text: chip.content,
            },
          });
        } else {
          out.push({ type: "resource_link", name: chip.name, uri: chip.uri });
        }
      }
    }
    return out;
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
    setText(
      (previous) =>
        `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${value}`,
    );
    setShortcutScope(null);
    setMentionAt(-1);
    areaRef.current?.focus();
  };
  const ownsAddMenu = () => !inputDisabled && plusOwner.current === storageKey;
  const findProjectFile = () => {
    if (!ownsAddMenu() || !cwd) return;
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
      const payload = blocks(prepared);
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
      if (onSend) {
        await onSend(payload, submitted);
      } else if (thread) {
        await threads.send(thread.key, payload);
      }
      composerDrafts.clearIfUnchanged(targetKey, submitted);
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
        setSendError(uiError(error, STRINGS.repair.sendFailed));
    } finally {
      if (liveKey.current === targetKey) busy.current = false;
    }
  };

  const pickFiles = async () => {
    const generation = composerDrafts.generation(storageKey);
    let picked: string | string[] | null;
    try {
      picked = await openDialog({ multiple: true });
    } catch (error) {
      if (liveKey.current === storageKey)
        setSendError(uiError(error, STRINGS.repair.requestFailed));
      return;
    }
    if (!picked || composerDrafts.generation(storageKey) !== generation) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    try {
      const additions = paths.map((p) => ({
        id: crypto.randomUUID(),
        kind: "file" as const,
        name: basename(p),
        uri: filePathUri(p),
      }));
      setChips((prev) => [...prev, ...additions]);
    } catch {
      if (liveKey.current === storageKey)
        setSendError(STRINGS.repair.requestFailed);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0 || inputDisabled) return;
    // Agent 不支持图片时按规格忽略。
    if (!imageEnabled) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    for (const file of files) {
      const id = crypto.randomUUID();
      setChips((prev) => [
        ...prev,
        {
          id,
          kind: "image",
          name: `pasted.${(file.type.split("/")[1] ?? "png").split(";")[0]}`,
          mimeType: file.type,
          loading: true,
        },
      ]);
      draftPersistence.trackAttachment(
        fileToDataUrl(file)
          .then((url) => {
            setChips((prev) =>
              prev.map((chip) =>
                chip.id === id
                  ? { ...chip, data: url.split(",")[1] ?? "", loading: false }
                  : chip,
              ),
            );
          })
          .catch(() => {
            setChips((prev) =>
              prev.map((chip) =>
                chip.id === id ? { ...chip, loading: false } : chip,
              ),
            );
            if (liveKey.current === storageKey)
              setSendError(DRAFT_STRINGS.attachmentIncomplete);
          }),
      );
    }
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
    if ((slashOpen && slashList.length > 0) || mentionOpen) {
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
  const notes: [string | null | undefined, boolean][] = [
    [permissionNote, false],
    [unsupportedImages ? W.imageUnsupported : null, false],
    [suppressThreadOpenError ? null : thread?.openError, true],
    [thread?.configError, false],
    [sendError, false],
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
    [note, noteAction],
  ];
  const [openNote, showAction] = notes.find(([text]) => Boolean(text)) ?? [
    null,
    false,
  ];
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
      {agentCommandsOpen ? (
        <>
          <p>{C.agentCommandsHint}</p>
          {commands.map((command) => (
            <button
              key={command.name}
              type="button"
              onClick={() => {
                if (
                  !ownsAddMenu() ||
                  !liveCommands.current.some(
                    (item) => item.name === command.name,
                  )
                )
                  return;
                setText((previous) => `/${command.name} ${previous}`);
                setPlusOpen(false);
                setMentionAt(-1);
                areaRef.current?.focus();
              }}
            >
              <CommandIcon size={19} />
              <span>
                <strong>/{command.name}</strong>
                {command.description && <small>{command.description}</small>}
              </span>
            </button>
          ))}
          {!commands.length && <p role="status">{C.agentCommandsEmpty}</p>}
          <button type="button" onClick={() => setAgentCommandsOpen(false)}>
            {C.backToAdd}
          </button>
        </>
      ) : (
        <>
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
            <button type="button" disabled={!cwd} onClick={findProjectFile}>
              <FileTextIcon size={19} />
              <span>
                <strong>{C.findProjectFile}</strong>
                <small>{C.findProjectFileHint}</small>
              </span>
            </button>
          )}
          {(!thread || thread.identity === "draft") && (
            <button
              type="button"
              onClick={() => {
                if (ownsAddMenu()) setAgentCommandsOpen(true);
              }}
            >
              <CommandIcon size={19} />
              <span>
                <strong>{C.agentCommands}</strong>
              </span>
            </button>
          )}
          {attachmentControls}
        </>
      )}
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
        <div className="auth-note" role="alert">
          <span>{draftSave.error}</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void draftPersistence.flush().catch(() => undefined)}
          >
            {DRAFT_STRINGS.retry}
          </button>
        </div>
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
                          uiError(error, STRINGS.repair.reconnectFailed),
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
        <WorkspaceDialog
          title={DRAFT_STRINGS.abandonPending}
          onClose={() => setAbandonPending(null)}
        >
          <p>{DRAFT_STRINGS.abandonPendingNote}</p>
          <div className="workspace-dialog-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAbandonPending(null)}
            >
              {LIBRARY.cancel}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                abandonPendingConversation(storageKey, abandonPending);
                setAbandonPending(null);
              }}
            >
              {DRAFT_STRINGS.abandonPending}
            </button>
          </div>
        </WorkspaceDialog>
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
                        uiError(reason, STRINGS.repair.requestFailed),
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
              className="btn btn-ghost"
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
        <div className="auth-note">
          <span>{openNote}</span>
          {workAgentId && work.ready && !work.enabled(workAgentId) && (
            <button
              type="button"
              className="btn btn-ghost"
              title={
                work.locationEnabled === false
                  ? `${workCwd}\n${SEND.resumeHint}`
                  : (workCwd ?? undefined)
              }
              disabled={work.saving}
              onClick={() =>
                void (work.locationEnabled === false
                  ? work.setLocation(true)
                  : work.set(workAgentId, true))
              }
            >
              {work.saving
                ? W.enablingWork
                : work.locationEnabled === false
                  ? SEND.resumeLocation
                  : W.enableWork}
            </button>
          )}
          {work.error && !work.ready && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={work.retry}
            >
              {STRINGS.service.retry}
            </button>
          )}
          {showAction && (
            <button
              type="button"
              className="btn btn-text"
              onClick={onGoSettings}
            >
              {STRINGS.empty.goSettings}
            </button>
          )}
        </div>
      )}
      {browserSuggestionsReady && slashOpen && slashList.length > 0 && (
        <div className="pick-menu" role="listbox">
          {slashList.map((command, i) => (
            <div
              key={command.name}
              role="option"
              aria-selected={i === pickIndex}
              className={`pm${i === pickIndex ? " on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(i);
              }}
            >
              <span className="pm-name">/{command.name}</span>
              {command.description && (
                <span className="pm-desc">{command.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {browserSuggestionsReady && mentionOpen && (
        <div className="pick-menu" role="listbox">
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
          {fileList.length === 0 && (
            <div className="pm pm-dim">{STRINGS.composer.noFileMatch}</div>
          )}
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
      <div className={`composer-box${focus ? " focus" : ""}`}>
        {contextChips}
        {chips.length > 0 && (
          <div className="c-chips">
            {chips.map((chip, i) => (
              <span key={chip.id} className="c-chip">
                {chip.data && (
                  <img
                    src={`data:${chip.mimeType};base64,${chip.data}`}
                    alt=""
                  />
                )}
                {chip.name}
                <button
                  type="button"
                  className="x"
                  aria-label={W.removeAttachment(chip.name)}
                  onClick={() =>
                    setChips((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
                setAgentCommandsOpen(false);
                setPlusOpen((v) => !v);
              }}
            >
              <PlusIcon size={20} />
            </button>
            {controls}
            {thread?.identity === "established" && !queueEditing && (
              <button
                ref={shortcutAnchor}
                type="button"
                className="icon-btn"
                title={C.shortcutsTitle}
                aria-label={C.shortcutsTitle}
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
                title={sendLabel}
                aria-label={sendLabel}
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
          title={C.shortcutsTitle}
          onClose={() => setShortcutScope(null)}
        >
          <div className="workspace-action-body composer-shortcuts">
            <span className="composer-shortcuts-title">{C.shortcutsHint}</span>
            {C.shortcuts.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                className="btn btn-ghost"
                onClick={() => insertShortcut(shortcut.text)}
              >
                <CommandIcon size={15} />
                <span>{shortcut.label}</span>
              </button>
            ))}
          </div>
        </WorkspaceActionMenu>
      )}
      <div className="composer-footer">
        {caption && <span className="composer-caption">{caption}</span>}
        <span className="c-hint">
          {queueEditing
            ? C.queueEditHint
            : stopPending
              ? C.stopSendingPaused
              : running
                ? STRINGS.composer.hintQueue
                : W.keyboardSend}
        </span>
      </div>
      {active && plusOpen && (
        <WorkspaceActionMenu
          key={agentCommandsOpen ? "commands" : "add"}
          anchor={plusAnchor.current}
          title={agentCommandsOpen ? C.agentCommands : C.addTitle}
          onClose={() => setPlusOpen(false)}
        >
          {addContents}
        </WorkspaceActionMenu>
      )}
    </div>
  );
}
