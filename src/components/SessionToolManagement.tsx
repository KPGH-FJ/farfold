import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { threads, type ThreadState } from "../runtime/sessions";
import { getSessionToolChangeController } from "../runtime/session_tool_change_controller";
import { SESSION_TOOL_CHANGE_STRINGS as S } from "../runtime/session_tool_change_strings";
import { MCP_HTTP_ADD_STRINGS as H } from "../runtime/mcp_add_strings";
import type { McpHttpInput } from "../runtime/mcp_add_types";
import {
  sessionToolHttpInputError,
  type SessionManagedTool,
} from "../runtime/session_tool_change_types";
import { McpHttpFields } from "./McpHttpFields";
import "./McpAddForm.css";

export function SessionToolManagement({
  thread,
  active,
  readPending,
}: {
  thread: ThreadState;
  active: boolean;
  readPending: boolean;
}) {
  const controller = useMemo(
    () =>
      getSessionToolChangeController(thread, () => threads.thread(thread.key)),
    [
      thread,
      thread.connectionId,
      thread.nativeSessionId,
      thread.cwd,
      thread.serviceContext,
      thread.service?.id,
      thread.service?.fingerprint,
    ],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  type Draft = {
    owner: typeof controller;
    input: McpHttpInput;
    reviewing: boolean;
  };
  const [draft, setDraft] = useState<Draft | null>(() => null);
  const [removing, setRemoving] = useState<{
    owner: typeof controller;
    item: SessionManagedTool;
  } | null>(() => null);
  const mounted = useRef(true);
  const live = useRef({ controller, active, readPending, draft, removing });
  live.current = { controller, active, readPending, draft, removing };
  const replaceDraft = (next: Draft | null) => {
    live.current.draft = next;
    setDraft(next);
  };
  const replaceRemoving = (next: typeof removing) => {
    live.current.removing = next;
    setRemoving(next);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const own = () =>
    mounted.current &&
    live.current.controller === controller &&
    live.current.active &&
    controller.isCurrent();
  const blocked = controller.blockedCode;
  const canEdit = () =>
    own() &&
    !live.current.readPending &&
    !controller.blockedCode &&
    !controller.getSnapshot().unresolved &&
    !controller.getSnapshot().listing;
  const input = draft?.owner === controller ? draft.input : null;
  const selected = removing?.owner === controller ? removing.item : null;
  const enabled =
    active &&
    controller.isCurrent() &&
    !readPending &&
    !blocked &&
    !view.unresolved &&
    !view.listing;
  const error = input ? sessionToolHttpInputError(input) : null;
  const reviewing = input && draft?.reviewing;
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (input || selected) heading.current?.focus();
    else if (wasEditing.current) {
      if (view.unresolved) checkButton.current?.focus();
      else addButton.current?.focus();
    }
    wasEditing.current = !!input || !!selected;
  }, [!!input, !!selected, !!reviewing, view.unresolved]);
  const abandon = () => {
    if (!own()) return;
    replaceDraft(null);
    replaceRemoving(null);
    addButton.current?.focus();
  };
  const operation = view.operation;
  const inspection = view.kind === "inspect";
  const message = view.checking
    ? inspection
      ? S.listing
      : S.checking
    : view.error
      ? inspection
        ? S.inspectFailed
        : S.errors[view.error]
      : view.recovered
        ? S.recovered
        : view.unresolved
          ? inspection
            ? S.inspectPending
            : S.pending
          : operation?.state === "ready"
            ? inspection
              ? S.inspected
              : view.kind === "addHttp"
                ? S.added
                : operation.activity === "absentReported"
                  ? S.removed
                  : S.removedSavedOnly
            : "";
  return (
    <section
      className="session-tool-management mcp-add-form"
      aria-label={S.title}
    >
      <h3>{S.title}</h3>
      <p className="session-tools-note">{S.scope}</p>
      <p role="status" aria-atomic="true">
        {message}
      </p>
      {operation && !inspection && (
        <p className="session-tools-note">
          {operation.persistence === "confirmed" ? S.saved : S.saveUnknown}。{" "}
          {operation.activity === "toolsReported"
            ? S.tools
            : operation.activity === "absentReported"
              ? S.absent
              : S.activityUnknown}
          。
        </p>
      )}
      {!view.itemsRead && !view.unresolved && <p>{S.initial}</p>}
      <div className="session-tool-actions">
        <button
          ref={addButton}
          type="button"
          className="btn btn-ghost"
          disabled={!enabled || !!input || !!selected}
          onClick={() => {
            if (canEdit() && !live.current.draft && !live.current.removing)
              replaceDraft({
                owner: controller,
                input: { transport: "streamableHttp", name: "", url: "" },
                reviewing: false,
              });
          }}
        >
          {S.add}
        </button>
        <button
          ref={checkButton}
          type="button"
          className="btn btn-ghost"
          aria-disabled={
            (view.unresolved
              ? view.checking || !active || !controller.isCurrent()
              : !enabled || !!input || !!selected) || undefined
          }
          onClick={() => {
            if (!own()) return;
            if (controller.getSnapshot().unresolved) controller.check();
            else if (canEdit() && !live.current.draft && !live.current.removing)
              controller.list();
          }}
        >
          {view.unresolved
            ? view.checking
              ? inspection
                ? S.listing
                : S.checking
              : inspection
                ? S.checkInspection
                : S.check
            : view.listing
              ? S.listing
              : S.list}
        </button>
      </div>
      {input && (
        <>
          <h4 ref={heading} tabIndex={-1}>
            {S.addHeading}
          </h4>
          {reviewing ? (
            <>
              <dl className="session-tool-review">
                <dt>{S.name}</dt>
                <dd>
                  <bdi>{input.name}</bdi>
                </dd>
                <dt>{S.address}</dt>
                <dd>
                  <code>{input.url}</code>
                </dd>
              </dl>
              <p>{S.addEffects}</p>
              <p className="session-tools-note">{S.secrets}</p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!enabled || !!error}
                onClick={() => {
                  if (
                    !canEdit() ||
                    error ||
                    live.current.draft !== draft ||
                    draft?.owner !== controller ||
                    !draft.reviewing
                  )
                    return;
                  if (
                    controller.start({
                      kind: "addHttp",
                      name: input.name,
                      url: input.url,
                    })
                  )
                    replaceDraft(null);
                }}
              >
                {S.confirmAdd}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (
                    own() &&
                    live.current.draft === draft &&
                    !controller.getSnapshot().unresolved
                  )
                    replaceDraft({
                      owner: controller,
                      input,
                      reviewing: false,
                    });
                }}
              >
                {S.cancelReview}
              </button>
            </>
          ) : (
            <>
              <p>{S.guidance}</p>
              <p className="session-tools-note">{S.secrets}</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canEdit() && live.current.draft === draft && !error)
                    replaceDraft({
                      owner: controller,
                      input: { ...input },
                      reviewing: true,
                    });
                }}
              >
                <McpHttpFields
                  input={input}
                  disabled={!enabled}
                  onChange={(value) => {
                    if (canEdit() && live.current.draft === draft)
                      replaceDraft({
                        owner: controller,
                        input: value,
                        reviewing: false,
                      });
                  }}
                />
                {error && (
                  <p>
                    {error === "invalidName" ? S.invalidName : H.errors[error]}
                  </p>
                )}
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!enabled || !!error}
                >
                  {S.review}
                </button>
              </form>
              <button type="button" className="btn btn-ghost" onClick={abandon}>
                {S.closeForm}
              </button>
            </>
          )}
        </>
      )}
      {selected && (
        <>
          <h4 ref={heading} tabIndex={-1}>
            {S.removeHeading}
          </h4>
          <p>
            <bdi>{selected.name}</bdi>
          </p>
          <p>{S.removeEffects}</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!enabled || !view.itemsRead}
            onClick={() => {
              if (
                !canEdit() ||
                live.current.removing !== removing ||
                !controller
                  .getSnapshot()
                  .items.some((item) => item === selected)
              )
                return;
              if (
                controller.start({ kind: "remove", itemRef: selected.itemRef })
              )
                replaceRemoving(null);
            }}
          >
            {S.confirmRemove}
          </button>
          <button type="button" className="btn btn-ghost" onClick={abandon}>
            {S.cancelReview}
          </button>
        </>
      )}
      {view.items.length > 0 && (
        <>
          <h4>{view.itemsRead ? S.currentItems : S.previousItems}</h4>
          <ul className="session-tools-items">
            {view.items.map((item) => (
              <li key={item.itemRef}>
                <strong>
                  <bdi>{item.name}</bdi>
                </strong>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={
                    !enabled ||
                    !view.itemsRead ||
                    !item.canRemove ||
                    !!input ||
                    !!selected
                  }
                  aria-label={`${S.withdraw} ${item.name}`}
                  onClick={() => {
                    if (
                      canEdit() &&
                      item.canRemove &&
                      controller.getSnapshot().items.includes(item)
                    )
                      replaceRemoving({ owner: controller, item });
                  }}
                >
                  {S.withdraw}
                </button>
                {!item.canRemove && (
                  <p className="session-tools-note">{S.cannotRemove}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.itemsRead && view.items.length === 0 && (
        <p className="session-tools-note">{S.empty}</p>
      )}
      {!view.unresolved && blocked && <p>{S.errors[blocked]}</p>}
    </section>
  );
}
