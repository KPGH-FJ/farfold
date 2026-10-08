import { shortcutLabel } from "../runtime/platform_shortcuts";
import { useEffect, useRef, useState } from "react";
import {
  PlusIcon,
  MagnifyingGlassIcon,
  ChatsCircleIcon,
  StarIcon,
  CompassIcon,
  FolderSimpleIcon,
  GearSixIcon,
  SidebarSimpleIcon,
  CaretDownIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import type { SidebarRow } from "../runtime/sessions";
import {
  CollectionActionScope,
  collections,
  normalizeLibraryFilter,
  useCollections,
  useLibraryRows,
  type ConversationGroup,
  type LibraryFilter,
} from "../runtime/collections";
import { LIBRARY } from "../runtime/library_strings";
import { STRINGS } from "../runtime/strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { AgentLogo } from "./AgentLogo";
import { useComposerDraft } from "../runtime/drafts";

export function Sidebar({
  agents,
  active,
  filter,
  currentKey,
  onNew,
  onLibrary,
  onOpenRow,
  onSearch,
  onSettings,
  onExplore,
  onAllAgents,
  onCollapse,
}: {
  agents: AgentCardModel[];
  active: "start" | "thread" | "library" | "agents" | "settings";
  filter: LibraryFilter;
  /** The currently shown conversation's key, or null outside a thread view. */
  currentKey: string | null;
  onNew: () => void;
  onLibrary: (filter: LibraryFilter) => void;
  onOpenRow: (row: SidebarRow) => void;
  onSearch: (opener: HTMLButtonElement) => void;
  onSettings: () => void;
  onExplore: () => void;
  onAllAgents: () => void;
  onCollapse: () => void;
}) {
  const data = useCollections();
  const draft = useComposerDraft("new");
  const hasDraft = Boolean(draft.text.trim() || draft.attachments.length);
  const rows = useLibraryRows();
  const [recentExpanded, setRecentExpanded] = useState(true);
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [groupsExpanded, setGroupsExpanded] = useState(true);
  const [editing, setEditing] = useState<ConversationGroup | "new" | null>(
    null,
  );
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const attentionCount = rows.filter((row) => row.status === "need").length;
  const unknownCount = rows.filter(
    (row) => row.status === "need" && row.toolTailUnconfirmed,
  ).length;
  const attentionLabel =
    unknownCount === 0
      ? LIBRARY.attention
      : unknownCount === attentionCount
        ? STRINGS.thread.unknown
        : STRINGS.thread.needYou;
  const runningCount = rows.filter((row) => row.status === "run").length;
  const unreadCount = rows.filter((row) => row.unread).length;
  // 未发送草稿（无标题且无原生记录）不进最近列表。
  const recent = rows
    .filter((row) => row.title.trim() || row.nativeSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const recentTop = recent.slice(0, 8);
  const lastActivity = new Map<string, number>();
  for (const row of rows) {
    const at = lastActivity.get(row.agentId) ?? 0;
    if (row.updatedAt > at) lastActivity.set(row.agentId, row.updatedAt);
  }
  const orderedAgents = [...agents].sort(
    (a, b) =>
      (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0) ||
      a.name.localeCompare(b.name, "zh-Hans"),
  );
  const visibleAgents = orderedAgents.slice(0, 6);
  const operation = useRef(new CollectionActionScope());
  const editorReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const scope = operation.current;
    return () => scope.invalidate();
  }, []);
  const selectedScope = normalizeLibraryFilter(filter);
  const picked = (kind: LibraryFilter["kind"], id?: string) => {
    if (active !== "library") return false;
    if (kind === "agent") return selectedScope.agent === id;
    if (kind === "group") return selectedScope.group === id;
    if (kind === "favorites") return selectedScope.favorites;
    return (
      kind === "all" &&
      !selectedScope.agent &&
      !selectedScope.group &&
      !selectedScope.favorites
    );
  };
  const edit = (group: ConversationGroup | "new", opener: HTMLElement) => {
    editorReturnFocus.current = opener;
    operation.current.invalidate();
    setEditing(group);
    setName(group === "new" ? "" : group.name);
    setRemoving(false);
    setError(null);
  };
  const closeEditor = () => {
    operation.current.invalidate();
    setEditing(null);
  };
  const save = async () => {
    const target = editing;
    const requestedName = name;
    const deleting = removing;
    if (!target || (!deleting && !requestedName.trim())) return;
    await operation.current.run(
      async () => {
        if (target === "new") await collections.create(requestedName);
        else if (deleting) await collections.remove(target.id);
        else await collections.rename(target.id, requestedName);
      },
      {
        pending: (value) => {
          setSaving(value);
          if (value) setError(null);
        },
        success: () => setEditing(null),
        failure: () => setError(LIBRARY.saveError),
      },
    );
  };
  return (
    <aside className="sidebar product-sidebar">
      <div className="product-brand">
        <span className="product-brand-lockup" role="img" aria-label="Farfold">
          <img
            className="brand-light"
            src="/brand/farfold-horizontal-light.svg"
            alt=""
          />
          <img
            className="brand-dark"
            src="/brand/farfold-horizontal-dark.svg"
            alt=""
          />
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.collapseNav}
          onClick={onCollapse}
        >
          <SidebarSimpleIcon size={18} />
        </button>
      </div>
      <button
        type="button"
        className="product-new"
        aria-current={active === "start" ? "page" : undefined}
        onClick={onNew}
      >
        <PlusIcon size={18} />
        <span>{LIBRARY.newChat}</span>
        {hasDraft && <small className="draft-badge">{LIBRARY.draft}</small>}
        <kbd>{shortcutLabel("N")}</kbd>
      </button>
      <button
        type="button"
        className="product-search"
        onClick={(event) => onSearch(event.currentTarget)}
      >
        <MagnifyingGlassIcon size={16} />
        <span>{LIBRARY.search}</span>
        <kbd>{shortcutLabel("K")}</kbd>
      </button>
      <nav className="product-navigation" aria-label={LIBRARY.all}>
        <button
          type="button"
          className={picked("all") ? "active" : ""}
          onClick={() => onLibrary({ kind: "all" })}
        >
          <ChatsCircleIcon size={18} />
          <span>{LIBRARY.all}</span>
          <small>{rows.length}</small>
        </button>
        <button
          type="button"
          className={picked("favorites") ? "active" : ""}
          onClick={() => onLibrary({ kind: "favorites" })}
        >
          <StarIcon size={18} />
          <span>{LIBRARY.favorites}</span>
          <small>{rows.filter((r) => r.pinned).length}</small>
        </button>
        <button
          type="button"
          className={active === "agents" ? "active" : ""}
          onClick={onExplore}
        >
          <CompassIcon size={18} />
          <span>{LIBRARY.explore}</span>
        </button>
      </nav>
      <div className="product-side-scroll">
        {recentTop.length > 0 && (
          <section>
            <div className="product-section">
              <button
                type="button"
                aria-expanded={recentExpanded}
                onClick={() => setRecentExpanded(!recentExpanded)}
              >
                <CaretDownIcon
                  size={12}
                  style={{
                    transform: recentExpanded ? undefined : "rotate(-90deg)",
                  }}
                />
                {LIBRARY.recent}
              </button>
            </div>
            {recentExpanded && (
              <>
                {recentTop.map((row) => {
                  const card = agents.find((a) => a.id === row.agentId);
                  return (
                    <button
                      type="button"
                      key={row.key}
                      className={`product-recent ${currentKey === row.key ? "active" : ""}`}
                      onClick={() => onOpenRow(row)}
                    >
                      {card ? (
                        <AgentLogo card={card} />
                      ) : (
                        <ChatsCircleIcon size={17} />
                      )}
                      <span>{row.title || STRINGS.sessions.untitled}</span>
                      {(row.status === "need" ||
                        row.status === "run" ||
                        row.unread) && (
                        <i
                          className={
                            row.status === "need" ? "attention-dot" : ""
                          }
                        />
                      )}
                    </button>
                  );
                })}
                {recent.length > recentTop.length && (
                  <button
                    type="button"
                    className="product-side-more"
                    onClick={() => onLibrary({ kind: "all" })}
                  >
                    {LIBRARY.viewAll}
                  </button>
                )}
              </>
            )}
          </section>
        )}
        <section>
          <div className="product-section">
            <button
              type="button"
              aria-expanded={agentsExpanded}
              onClick={() => setAgentsExpanded(!agentsExpanded)}
            >
              <CaretDownIcon
                size={12}
                style={{
                  transform: agentsExpanded ? undefined : "rotate(-90deg)",
                }}
              />
              {LIBRARY.agents}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={LIBRARY.explore}
              onClick={onExplore}
            >
              <PlusIcon size={16} />
            </button>
          </div>
          {agentsExpanded &&
            visibleAgents.map((a) => (
              <button
                type="button"
                key={a.id}
                className={`product-agent ${picked("agent", a.id) ? "active" : ""}`}
                onClick={() => onLibrary({ kind: "agent", id: a.id })}
              >
                <AgentLogo card={a} />
                <span>{a.name}</span>
                <small>{rows.filter((r) => r.agentId === a.id).length}</small>
              </button>
            ))}
          {agentsExpanded && orderedAgents.length > visibleAgents.length && (
            <button
              type="button"
              className="product-side-more"
              onClick={onAllAgents}
            >
              {LIBRARY.moreAgents(orderedAgents.length)}
            </button>
          )}
        </section>
        <section>
          <div className="product-section">
            <button
              type="button"
              aria-expanded={groupsExpanded}
              onClick={() => setGroupsExpanded(!groupsExpanded)}
            >
              <CaretDownIcon
                size={12}
                style={{
                  transform: groupsExpanded ? undefined : "rotate(-90deg)",
                }}
              />
              {LIBRARY.groups}
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={!data.ready || data.saving}
              aria-label={LIBRARY.createGroup}
              onClick={(event) => edit("new", event.currentTarget)}
            >
              <PlusIcon size={16} />
            </button>
          </div>
          {data.error && (
            <div className="side-empty" role="alert">
              {data.error}
              {!data.ready && (
                <button
                  type="button"
                  className="btn btn-text"
                  onClick={() => void collections.load().catch(() => undefined)}
                >
                  {LIBRARY.retry}
                </button>
              )}
            </div>
          )}
          {groupsExpanded &&
            data.groups.map((g) => (
              <div
                className={`product-group ${picked("group", g.id) ? "active" : ""}`}
                key={g.id}
              >
                <button
                  type="button"
                  onClick={() => onLibrary({ kind: "group", id: g.id })}
                >
                  <FolderSimpleIcon size={17} />
                  <span>{g.name}</span>
                  <small>
                    {
                      rows.filter((r) => data.assignments[r.key] === g.id)
                        .length
                    }
                  </small>
                </button>
                <button
                  type="button"
                  className="icon-button group-menu"
                  aria-label={LIBRARY.actions(g.name)}
                  onClick={(event) => edit(g, event.currentTarget)}
                >
                  <DotsThreeIcon size={18} />
                </button>
              </div>
            ))}
        </section>
      </div>
      <div className="product-side-bottom">
        {(attentionCount > 0 || runningCount > 0 || unreadCount > 0) && (
          <div className="activity-links" aria-label={LIBRARY.activity}>
            {attentionCount > 0 && (
              <button
                type="button"
                onClick={() => onLibrary({ kind: "attention" })}
              >
                <i className="attention-dot" />
                {attentionCount} {attentionLabel}
              </button>
            )}
            {runningCount > 0 && (
              <button
                type="button"
                onClick={() => onLibrary({ kind: "running" })}
              >
                <i />
                {runningCount} {LIBRARY.running}
              </button>
            )}
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => onLibrary({ kind: "unread" })}
              >
                <i />
                {unreadCount} {LIBRARY.unread}
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className={`product-settings ${active === "settings" ? "active" : ""}`}
          onClick={onSettings}
        >
          <GearSixIcon size={18} />
          {LIBRARY.settings}
        </button>
        <small className="product-signature">{LIBRARY.tagline}</small>
      </div>
      {editing && (
        <WorkspaceDialog
          returnFocusRef={editorReturnFocus}
          busy={saving || data.saving}
          title={editing === "new" ? LIBRARY.createGroup : LIBRARY.renameGroup}
          onClose={closeEditor}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="workspace-dialog-body">
              {removing ? (
                <p>{LIBRARY.groupDeleteHint}</p>
              ) : (
                <label>
                  {LIBRARY.groupName}
                  <input
                    autoFocus
                    value={name}
                    disabled={saving}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              {editing !== "new" && !removing && (
                <button
                  type="button"
                  className="btn btn-text"
                  disabled={saving}
                  onClick={() => setRemoving(true)}
                >
                  {LIBRARY.removeGroup}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeEditor}
              >
                {LIBRARY.cancel}
              </button>
              <button
                className={`btn ${removing ? "btn-danger" : "btn-primary"}`}
                disabled={saving || data.saving || (!removing && !name.trim())}
              >
                {removing ? LIBRARY.removeGroup : LIBRARY.save}
              </button>
            </footer>
          </form>
        </WorkspaceDialog>
      )}
    </aside>
  );
}
