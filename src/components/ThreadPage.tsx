import { useEffect, useRef, useState } from "react";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";
import { browserSurfaceGuard } from "../runtime/browser_surface";
import {
  canMarkConversationRead,
  useVisibleConversation,
} from "../runtime/conversation_read_state";
import { NOTIFICATION_STRINGS as NOTICES } from "../runtime/desktop_notifications";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  FilesIcon,
  GlobeIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { ThreadView } from "./ThreadView";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { MoveConversationsDialog } from "./MoveConversationsDialog";
import { DeleteConversationsDialog } from "./DeleteConversationsDialog";
import type { useAgents } from "../runtime/agents";
import {
  CollectionActionScope,
  collections,
  useCollections,
} from "../runtime/collections";
import { LIBRARY } from "../runtime/library_strings";
import { useArchiveBlockReasons } from "../runtime/archive_blockers";
import {
  threads,
  paneCards,
  basename,
  hasActiveTools,
  useThread,
  useThreadsSnapshot,
  type Attachment,
  type IndexRow,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { readableTranscript } from "../runtime/readable_transcript";
import {
  exportFileName,
  transcriptMarkdown,
} from "../runtime/conversation_actions";
import { fileDelivery } from "../runtime/file_delivery";
import { uiError } from "../runtime/ui_error";

export function ThreadPage({
  onManualOpen,
  viewKey,
  active,
  agents,
  onGoSettings,
  onOpened,
  onRecover,
  onBack,
  onNew,
  onReopenSame,
  onNewFromMessage,
  navToggle,
  defaultCwd,
  onBrowserStateChange,
  draftComposerRef,
}: {
  onManualOpen?: () => void;
  draftComposerRef?: React.Ref<HTMLDivElement>;
  onBrowserStateChange?: (
    taskKey: string,
    page: BrowserWorkspaceState | null,
  ) => void;
  viewKey: string;
  active: boolean;
  agents: ReturnType<typeof useAgents>;
  onGoSettings: () => void;
  onOpened: (key: string) => void;
  onRecover?: (key: string) => Promise<void>;
  onBack: () => void;
  onNew: () => void;
  /** W3-9：用相同 Agent 与设置再开一段对话。 */
  onReopenSame?: (row: IndexRow) => void;
  /** W3-6：从一条用户消息开新对话，预填该对话的 Agent、位置与已存设置。 */
  onNewFromMessage?: (
    thread: ThreadState,
    item: { text: string; attachments: Attachment[] },
  ) => void;
  navToggle: React.ReactNode;
  defaultCwd?: string | null;
}) {
  const thread = useThread(viewKey);
  useEffect(() => {
    // A discarded empty draft no longer needs a retained render slot. Its
    // native close still belongs to the existing guard, including retries.
    if (!thread) onBrowserStateChange?.(viewKey, null);
  }, [thread, viewKey, onBrowserStateChange]);
  useVisibleConversation(
    active && thread ? viewKey : null,
    canMarkConversationRead(thread),
  );
  const snapshot = useThreadsSnapshot();
  const row = snapshot.index.find((r) => r.id === viewKey);
  const archiveReason = useArchiveBlockReasons([viewKey]).get(viewKey);
  const archiveBlocked = !row?.archived && archiveReason;
  // 删除与归档共用活跃度门禁：进行中或未确认的对话先完成再删除。
  const deleteBlocked = archiveReason;
  const title = thread?.title || row?.title || STRINGS.sessions.newSession;
  const artifactCount = thread ? paneCards(thread).length : 0;
  const canCopy =
    !!thread &&
    (thread.items.length > 0 ||
      thread.pendingPermissions.length > 0 ||
      thread.pendingElicitations.length > 0);
  const [contentMode, setContentMode] = useState<"files" | "browser">("files");
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(0);
  const host = useRef<HTMLElement>(null);
  const artifactReturnFocus = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [rename, setRename] = useState(false);
  const [name, setName] = useState(title);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const collectionsData = useCollections();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const actions = useRef(new CollectionActionScope());
  const closeDialog = () => {
    actions.current.invalidate();
    setMenu(false);
    setRename(false);
    setMoving(false);
    setDeleting(false);
    setError(null);
  };
  useEffect(() => {
    if (!active) closeDialog();
    return () => actions.current.invalidate();
  }, [active, viewKey]);
  const mutate = (action: () => Promise<void>) =>
    actions.current.run(action, {
      pending: setSaving,
      success: closeDialog,
      failure: (reason) => setError(uiError(reason, LIBRARY.error)),
    });
  useEffect(() => {
    const nodes = [
      ...(host.current?.querySelectorAll<HTMLElement>(
        ".msg-user, .assistant, .thinking-block, .steps",
      ) ?? []),
    ];
    const needle = query.trim().toLocaleLowerCase();
    const found = nodes.filter(
      (n) => !!needle && n.textContent?.toLocaleLowerCase().includes(needle),
    );
    nodes.forEach((n) => n.classList.toggle("search-match", found.includes(n)));
    setMatches(found.length);
    found[0]?.scrollIntoView({ block: "center" });
  }, [query, thread?.items.length]);
  const header = (
    <>
      <header className="workspace-topbar thread-topbar">
        {navToggle}
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.back}
          onClick={onBack}
        >
          <ArrowLeftIcon size={19} />
        </button>
        <div className="thread-title">
          <h1 title={title}>{title}</h1>
          <span title={thread?.cwd ?? row?.cwd}>
            {(thread?.cwd ?? row?.cwd) === defaultCwd
              ? LIBRARY.ordinary
              : basename(thread?.cwd ?? row?.cwd ?? "")}
            {thread && (
              <>
                {" "}
                ·{" "}
                {threads.needsAttention(thread)
                  ? LIBRARY.attention
                  : thread.running || hasActiveTools(thread)
                    ? LIBRARY.running
                    : LIBRARY.notRunning}
              </>
            )}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.find}
          onClick={() => setFinding(!finding)}
        >
          <MagnifyingGlassIcon size={20} />
        </button>
        <button
          type="button"
          className={`btn btn-ghost ${thread?.artifactPaneOpen ? "active" : ""}`}
          aria-label={thread?.artifactPaneOpen ? W.hideContent : W.showContent}
          title={thread?.artifactPaneOpen ? W.hideContent : W.showContent}
          aria-expanded={thread?.artifactPaneOpen ?? false}
          disabled={!thread}
          onClick={(event) => {
            if (thread?.artifactPaneOpen) threads.closeArtifactPane(viewKey);
            else {
              artifactReturnFocus.current = event.currentTarget;
              threads.openArtifactPane(viewKey);
            }
          }}
        >
          <FilesIcon size={20} />
          <span>{W.content}</span>
          {artifactCount > 0 && <small>{artifactCount}</small>}
        </button>
        <button
          type="button"
          className="icon-button desktop-browser-entry"
          aria-label={W.browser}
          title={W.browser}
          disabled={!thread}
          onClick={(event) => {
            artifactReturnFocus.current = event.currentTarget;
            setContentMode("browser");
            threads.openArtifactPane(viewKey);
          }}
        >
          <GlobeIcon size={20} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.actions(title)}
          ref={menuAnchor}
          aria-expanded={menu}
          aria-haspopup="dialog"
          onClick={() => {
            browserSurfaceGuard.runLatest(() => {
              actions.current.invalidate();
              setError(null);
              setMenu(!menu);
            });
          }}
        >
          <DotsThreeIcon size={22} />
        </button>
      </header>
      {finding && (
        <div className="thread-find">
          <input
            autoFocus
            aria-label={LIBRARY.find}
            placeholder={LIBRARY.findPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span>
            {query
              ? matches
                ? LIBRARY.findCount(matches)
                : LIBRARY.findEmpty
              : ""}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={LIBRARY.cancel}
            onClick={() => {
              setFinding(false);
              setQuery("");
            }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
  return (
    <main className="main workspace-thread" ref={host}>
      {thread ? (
        <ThreadView
          contentMode={contentMode}
          onContentModeChange={setContentMode}
          key={thread.key}
          thread={thread}
          active={active && !menu && !rename && !moving && !deleting}
          agents={agents.cards}
          onGoSettings={onGoSettings}
          onOpened={onOpened}
          onRecover={onRecover}
          onNew={onNew}
          onNewFromMessage={
            onNewFromMessage
              ? (item) => onNewFromMessage(thread, item)
              : undefined
          }
          header={header}
          artifactReturnFocusRef={artifactReturnFocus}
          onBrowserStateChange={onBrowserStateChange}
          draftComposerRef={draftComposerRef}
        />
      ) : (
        <>
          {header}
          <div className="library-empty">
            {onManualOpen ? (
              <>
                <p>{NOTICES.coldConversation}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onManualOpen}
                >
                  {NOTICES.openConversation}
                </button>
              </>
            ) : (
              STRINGS.common.loading
            )}
          </div>
        </>
      )}
      {active && menu && (
        <WorkspaceActionMenu
          anchor={menuAnchor.current}
          title={title}
          onClose={closeDialog}
        >
          <div className="workspace-action-body">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canCopy || saving}
              onClick={() =>
                void mutate(() =>
                  navigator.clipboard.writeText(
                    readableTranscript(
                      host.current?.querySelector(".transcript") ?? null,
                      title,
                    ),
                  ),
                )
              }
            >
              {LIBRARY.copy}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving}
              onClick={() => {
                setName(title);
                setRename(true);
                setMenu(false);
              }}
            >
              {LIBRARY.rename}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving}
              onClick={() =>
                void mutate(() => threads.setPinned(viewKey, !row?.pinned))
              }
            >
              {row?.pinned ? LIBRARY.unfavorite : LIBRARY.favorite}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving || Boolean(archiveBlocked)}
              aria-describedby={
                archiveBlocked ? "thread-archive-reason" : undefined
              }
              onClick={() =>
                void mutate(() => threads.setArchived(viewKey, !row?.archived))
              }
            >
              {row?.archived ? LIBRARY.restore : LIBRARY.archive}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                !thread ||
                saving ||
                !thread.items.some(
                  (item) => item.kind === "user" || item.kind === "agent",
                )
              }
              onClick={() =>
                void mutate(async () => {
                  if (!thread) return;
                  const text = transcriptMarkdown(
                    thread,
                    title,
                    agents.cards.find((a) => a.id === thread.agentId)?.name ??
                      thread.agentId,
                  );
                  const destination = await save({
                    defaultPath: exportFileName(title),
                  });
                  if (!destination) return;
                  await fileDelivery.exportText(text, destination);
                })
              }
            >
              {LIBRARY.exportMarkdown}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                !row ||
                saving ||
                !collectionsData.ready ||
                collectionsData.saving
              }
              onClick={() => {
                setMenu(false);
                setMoving(true);
              }}
            >
              {LIBRARY.assign}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving || !(thread?.cwd ?? row?.cwd)}
              onClick={() =>
                void mutate(() =>
                  fileDelivery.revealLocation(
                    (thread?.cwd ?? row?.cwd) as string,
                  ),
                )
              }
            >
              {LIBRARY.revealLocation}
            </button>
            {onReopenSame && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!row || saving}
                onClick={() => {
                  setMenu(false);
                  if (row) onReopenSame(row);
                }}
              >
                {LIBRARY.reopenSame}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving || Boolean(deleteBlocked)}
              aria-describedby={
                deleteBlocked ? "thread-delete-reason" : undefined
              }
              onClick={() => {
                setMenu(false);
                setDeleting(true);
              }}
            >
              {LIBRARY.deleteAction}
            </button>
            {deleteBlocked && (
              <p className="archive-block-reason" id="thread-delete-reason">
                {LIBRARY.deleteReasons[deleteBlocked]}
              </p>
            )}
            {archiveBlocked && (
              <p className="archive-block-reason" id="thread-archive-reason">
                {LIBRARY.archiveReasons[archiveBlocked]}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </WorkspaceActionMenu>
      )}
      {active && moving && row && (
        <MoveConversationsDialog
          count={1}
          returnFocusRef={menuAnchor}
          groups={collectionsData.groups}
          busy={saving || !collectionsData.ready || collectionsData.saving}
          error={error}
          onClose={closeDialog}
          onMove={(groupId) =>
            void mutate(() => collections.assign([viewKey], groupId))
          }
        />
      )}
      {active && deleting && row && (
        <DeleteConversationsDialog
          title={LIBRARY.deleteTitle(1)}
          hint={LIBRARY.deleteHintOne(title)}
          busy={saving}
          error={error}
          returnFocusRef={menuAnchor}
          onClose={closeDialog}
          onDelete={() =>
            void mutate(async () => {
              await threads.delete(row);
              onBack();
            })
          }
        />
      )}
      {active && rename && (
        <WorkspaceDialog
          title={LIBRARY.rename}
          onClose={closeDialog}
          returnFocusRef={menuAnchor}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim())
                void mutate(() => threads.rename(viewKey, name.trim()));
            }}
          >
            <div className="workspace-dialog-body">
              <label>
                {LIBRARY.title}
                <input
                  autoFocus
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              <button
                className="btn btn-primary"
                disabled={!name.trim() || saving}
              >
                {LIBRARY.save}
              </button>
            </footer>
          </form>
        </WorkspaceDialog>
      )}
    </main>
  );
}
