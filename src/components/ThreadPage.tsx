import {
  AttachmentSearchJump,
  type AttachmentSearchRequest,
} from "./AttachmentSearchJump";
import { ConversationExportHost } from "./ConversationExportHost";
import {
  captureConversationExport,
  releasedExportSnapshot,
  hasExportableContent,
  type ConversationExportSnapshot,
} from "../runtime/conversation_archive_snapshot";
import { ARCHIVE_STRINGS } from "../runtime/conversation_archive_strings";
import { TranscriptSearchContext } from "./transcript-search";
import { ConversationFind } from "./ConversationFind";
import { HistoryReadStatus } from "./HistoryReadStatus";
import { LoadedSearchJump, type LoadedSearchRequest } from "./LoadedSearchJump";
import { useEffect, useRef, useState } from "react";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";
import { ownerForRememberedPages } from "../runtime/browser_remembered";
import { browserSurfaceGuard } from "../runtime/browser_surface";
import {
  canMarkConversationRead,
  useVisibleConversation,
} from "../runtime/conversation_read_state";
import { NOTIFICATION_STRINGS as NOTICES } from "../runtime/desktop_notifications";
import {
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  FilesIcon,
  GlobeIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { useContentOwner } from "./useContentOwner";
import { ThreadView } from "./ThreadView";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { SessionForkDialog } from "./SessionForkDialog";
import { sessionForkControl } from "../runtime/session_fork_ui";
import { SESSION_FORK_STRINGS as FORK } from "../runtime/session_fork_strings";
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
  basename,
  hasActiveWork,
  useThread,
  useThreadsSnapshot,
  type Attachment,
  type IndexRow,
  type ThreadState,
} from "../runtime/sessions";
import { reportedArtifactCount } from "../runtime/reported_artifacts";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { readableTranscript } from "../runtime/readable_transcript";
import { exportFileName } from "../runtime/conversation_actions";
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
  onBrowserOwnersChange,
  draftComposerRef,
  preparedComposerIsCurrent,
  searchRequest,
  attachmentSearchRequest,
}: {
  onManualOpen?: () => void;
  searchRequest?: LoadedSearchRequest | null;
  attachmentSearchRequest?: AttachmentSearchRequest | null;
  draftComposerRef?: React.Ref<HTMLDivElement>;
  preparedComposerIsCurrent?: (() => boolean) | null;
  onBrowserOwnersChange?: (taskKey: string, ownsPages: boolean) => void;
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
  const ownsContent = useContentOwner(thread, active);
  useEffect(() => {
    // A discarded empty draft no longer needs a retained render slot. Its
    // native close still belongs to the existing guard, including retries.
    if (!thread) {
      onBrowserStateChange?.(viewKey, null);
      onBrowserOwnersChange?.(viewKey, false);
    }
  }, [thread, viewKey, onBrowserStateChange, onBrowserOwnersChange]);
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
  const artifactCount = thread ? (reportedArtifactCount(thread, null) ?? 0) : 0;
  const canCopy =
    !!thread &&
    (thread.items.length > 0 ||
      thread.pendingPermissions.length > 0 ||
      thread.pendingElicitations.length > 0);
  const [contentMode, setContentMode] = useState<"files" | "browser">("files");
  const [finding, setFinding] = useState(false);
  const [closedSearch, setClosedSearch] = useState<object | null>(null);
  const loadedSearch =
    active &&
    searchRequest?.hit.threadKey === viewKey &&
    closedSearch !== searchRequest.token
      ? searchRequest
      : null;
  const attachmentSearch =
    active &&
    attachmentSearchRequest?.source.threadKey === viewKey &&
    closedSearch !== attachmentSearchRequest.token
      ? attachmentSearchRequest
      : null;
  const findTrigger = useRef<HTMLButtonElement>(null);
  const [exported, setExported] = useState<{
    capture: ConversationExportSnapshot;
    name: string;
  } | null>(null);
  const host = useRef<HTMLElement>(null);
  const artifactReturnFocus = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [rename, setRename] = useState(false);
  const [name, setName] = useState(title);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const forkControl = sessionForkControl(thread, onOpened);
  const [forkReview, setForkReview] = useState<{
    owner: object;
    thread: ThreadState;
    connectionId: string | undefined;
    isCurrent: () => boolean;
    retired: boolean;
  } | null>(null);
  if (
    forkReview &&
    (!active ||
      forkReview.owner !== forkControl?.owner ||
      forkReview.thread !== thread ||
      forkReview.connectionId !== thread?.connectionId)
  )
    forkReview.retired = true;
  const forkVisible = Boolean(forkReview && !forkReview.retired);
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
    if (forkReview) forkReview.retired = true;
    setForkReview(null);
    setExported(null);
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
                  : thread.running || hasActiveWork(thread)
                    ? LIBRARY.running
                    : LIBRARY.notRunning}
              </>
            )}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          ref={findTrigger}
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
            if (!ownsContent()) return;
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
      <HistoryReadStatus target={viewKey} active={active} />
      {active && finding && (
        <ConversationFind
          key={viewKey}
          host={host}
          revision={snapshot.version}
          onClose={() => {
            setFinding(false);
            findTrigger.current?.focus();
          }}
        />
      )}
      {attachmentSearch && (
        <AttachmentSearchJump
          host={host}
          request={attachmentSearch}
          revision={snapshot.version}
          onClose={() => setClosedSearch(attachmentSearch.token)}
        />
      )}
      {loadedSearch && (
        <LoadedSearchJump
          host={host}
          request={loadedSearch}
          revision={snapshot.version}
          onClose={() => setClosedSearch(loadedSearch.token)}
        />
      )}
    </>
  );
  return (
    <TranscriptSearchContext.Provider
      value={active && (finding || !!loadedSearch || !!attachmentSearch)}
    >
      <main className="main workspace-thread" ref={host}>
        {thread ? (
          <ThreadView
            contentMode={contentMode}
            onContentModeChange={setContentMode}
            key={thread.key}
            thread={thread}
            rememberedBrowserOwner={ownerForRememberedPages(thread, row)}
            active={
              active &&
              !menu &&
              !rename &&
              !moving &&
              !deleting &&
              !exported &&
              !forkVisible
            }
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
            onBrowserOwnersChange={onBrowserOwnersChange}
            draftComposerRef={draftComposerRef}
            preparedComposerIsCurrent={preparedComposerIsCurrent}
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
                  void mutate(() =>
                    threads.setArchived(viewKey, !row?.archived),
                  )
                }
              >
                {row?.archived ? LIBRARY.restore : LIBRARY.archive}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!thread || saving || !hasExportableContent(thread)}
                onClick={() => {
                  if (!thread) return;
                  try {
                    setExported({
                      capture: captureConversationExport(
                        thread,
                        title,
                        agents.cards.find(
                          (agent) => agent.id === thread.agentId,
                        )?.name ?? thread.agentId,
                      ),
                      name: exportFileName(title),
                    });
                  } catch {
                    setError(ARCHIVE_STRINGS.errors.tooLarge);
                  }
                  setMenu(false);
                }}
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
              {forkControl && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={
                      saving ||
                      (forkControl.phase === "idle" &&
                        Boolean(forkControl.blockedReason))
                    }
                    aria-describedby={
                      forkControl.phase === "idle" && forkControl.blockedReason
                        ? "thread-fork-reason"
                        : undefined
                    }
                    onClick={() => {
                      if (
                        !active ||
                        !thread ||
                        !ownsContent() ||
                        !forkControl.isCurrent() ||
                        (forkControl.phase === "idle" &&
                          forkControl.blockedReason)
                      )
                        return;
                      setMenu(false);
                      setForkReview({
                        owner: forkControl.owner,
                        thread,
                        connectionId: thread.connectionId,
                        isCurrent: ownsContent,
                        retired: false,
                      });
                    }}
                  >
                    {forkControl.phase === "idle"
                      ? FORK.title
                      : forkControl.phase === "pending"
                        ? FORK.progress
                        : FORK.result}
                  </button>
                  {forkControl.phase === "idle" &&
                    forkControl.blockedReason && (
                      <p
                        className="archive-block-reason"
                        id="thread-fork-reason"
                      >
                        {forkControl.blockedReason}
                      </p>
                    )}
                </>
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
        {active && exported && (
          <ConversationExportHost
            {...exported}
            onRegistered={() =>
              setExported((current) =>
                current
                  ? {
                      ...current,
                      capture: releasedExportSnapshot(current.capture),
                    }
                  : null,
              )
            }
            returnFocusRef={menuAnchor}
            onClose={() => setExported(null)}
          />
        )}
        {active && forkVisible && forkReview && forkControl && (
          <SessionForkDialog
            control={
              forkControl.prepareNew
                ? {
                    ...forkControl,
                    prepareNew: () => {
                      if (
                        forkReview.retired ||
                        !forkReview.isCurrent() ||
                        forkReview.thread !== thread ||
                        forkReview.connectionId !== thread.connectionId ||
                        forkReview.owner !== forkControl.owner ||
                        !forkControl.isCurrent()
                      )
                        return;
                      forkReview.retired = true;
                      setForkReview(null);
                      forkControl.prepareNew?.();
                      const next = sessionForkControl(thread, onOpened);
                      if (
                        !forkReview.isCurrent() ||
                        forkReview.connectionId !== thread.connectionId ||
                        !next ||
                        next.phase !== "idle" ||
                        next.owner === forkReview.owner ||
                        !next.isCurrent()
                      )
                        return;
                      setForkReview({
                        owner: next.owner,
                        thread,
                        connectionId: thread.connectionId,
                        isCurrent: forkReview.isCurrent,
                        retired: false,
                      });
                    },
                  }
                : forkControl
            }
            active={active}
            isCurrent={() =>
              !forkReview.retired &&
              forkReview.isCurrent() &&
              forkReview.thread === thread &&
              forkReview.connectionId === thread.connectionId &&
              forkReview.owner === forkControl.owner
            }
            onClose={closeDialog}
            returnFocusRef={menuAnchor}
          />
        )}
        {active && moving && row && (
          <MoveConversationsDialog
            count={1}
            rows={[
              { title, groupId: collectionsData.assignments[viewKey] ?? "" },
            ]}
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
            targets={[title]}
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
            busy={saving}
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
    </TranscriptSearchContext.Provider>
  );
}
