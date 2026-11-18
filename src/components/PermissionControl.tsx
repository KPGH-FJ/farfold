import { useEffect, useRef, useState } from "react";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import {
  configValueLabel,
  hasActiveWork,
  threads,
  type ConfigChoice,
  type ThreadState,
} from "../runtime/sessions";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { LIBRARY } from "../runtime/library_strings";
import { uiError } from "../runtime/ui_error";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspacePopover } from "./WorkspacePopover";
import { PermissionRules } from "./PermissionRules";
import { hasNextOrdinaryPermissionEffect } from "../runtime/permission_effect";
import { configChangeBusy } from "../runtime/protected_config";

interface PermissionReview {
  owner: ThreadState;
  choice: ConfigChoice;
  options: string;
}

/** Only the access layer can identify a verified permission setting. */
export function PermissionControl({
  thread,
  inactive = false,
}: {
  thread: ThreadState;
  /** Keep the control mounted but inert while a menu/dialog owns the surface
   *  so composer siblings do not reflow (W3-2). */
  inactive?: boolean;
}) {
  const [review, setReview] = useState<PermissionReview | null>(null);
  const [failure, setFailure] = useState<{
    owner: ThreadState;
    message: string;
  } | null>(null);
  const owner = useRef(thread);
  const currentReview = useRef(review);
  owner.current = thread;
  const changeReview = (next: PermissionReview | null) => {
    currentReview.current = next;
    setReview(next);
  };
  useEffect(() => {
    changeReview(null);
    setFailure(null);
  }, [thread]);
  const activeReview = review?.owner === thread ? review : null;
  const choice = activeReview?.choice;
  const error = failure?.owner === thread ? failure.message : null;
  const option = thread.configOptions.find(
    (item) => item.id === thread.permissionConfigId,
  );
  const hasSetting = Boolean(thread.permissionConfigId);
  const { connectionId } = thread;
  const showRules =
    thread.identity === "established" &&
    Boolean(thread.agentId && thread.cwd && thread.nativeSessionId) &&
    thread.sessionOperations?.permissionRulesRead === true;
  if (!hasSetting && (!showRules || !connectionId)) return null;
  const rulesBlocked = showRules && configChangeBusy(thread);
  const unavailable =
    !option || option.type !== "select" || !option.options.length;
  const optionsIdentity = JSON.stringify({
    description: option?.description,
    options: option?.options,
  });
  const staleChoice = choice && activeReview?.options !== optionsIdentity;
  const nextMessage = hasNextOrdinaryPermissionEffect(thread);
  const scopeNote = nextMessage ? C.permissionNextScope : C.permissionScope;
  const blocked =
    inactive ||
    thread.configuring ||
    thread.running ||
    hasActiveWork(thread) ||
    thread.submitting ||
    thread.stopping ||
    thread.stopUnconfirmed ||
    thread.reconnecting ||
    thread.connectionLost ||
    Boolean(thread.openError) ||
    thread.pendingPermissions.length > 0 ||
    thread.pendingElicitations.length > 0;
  const label =
    thread.permissionState === "required"
      ? C.permissionRequired
      : thread.permissionState === "unknown"
        ? C.permissionUnknown
        : thread.permissionState === "changing"
          ? C.permissionChanging
          : option
            ? configValueLabel(option)
            : C.permissionUnknown;
  const apply = async () => {
    if (thread.identity === "draft" && pendingPreparationRead(thread)) return;
    if (
      !activeReview ||
      !choice ||
      blocked ||
      !option ||
      unavailable ||
      threads.thread(thread.key) !== thread
    )
      return;
    if (
      staleChoice ||
      !option.options.some((item) => item.value === choice.value)
    ) {
      setFailure({ owner: thread, message: C.permissionChanged });
      return;
    }
    const stillCurrent = () =>
      owner.current === thread &&
      threads.thread(thread.key) === thread &&
      currentReview.current === activeReview;
    setFailure(null);
    try {
      await threads.setConfig(thread.key, option.id, choice.value);
      if (!stillCurrent()) return;
      if (thread.permissionState !== "ready")
        throw new Error(C.permissionFailure);
      changeReview(null);
    } catch (reason) {
      if (stillCurrent())
        setFailure({
          owner: thread,
          message: uiError(reason, C.permissionFailure),
        });
    }
  };
  return (
    <>
      <WorkspacePopover
        title={C.permission}
        label={
          <>
            <ShieldCheckIcon size={14} />
            <span>
              {C.permissionShort}
              {hasSetting && <> · {label}</>}
            </span>
          </>
        }
        disabled={blocked || (!hasSetting && rulesBlocked)}
      >
        {(close) => (
          <>
            {hasSetting && thread.permissionState === "required" && (
              <p className="workspace-control-note">
                {C.permissionRequiredNote}
              </p>
            )}
            {hasSetting && thread.permissionState === "unknown" && (
              <p className="workspace-control-note">
                {C.permissionUnknownNote}
              </p>
            )}
            {hasSetting && unavailable && (
              <>
                <p className="workspace-control-note">
                  {C.permissionUnavailable}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={blocked}
                  onClick={() => {
                    setFailure(null);
                    void threads.reconnect(thread.key).catch((reason) => {
                      if (
                        owner.current === thread &&
                        threads.thread(thread.key) === thread
                      )
                        setFailure({
                          owner: thread,
                          message: uiError(reason, C.permissionFailure),
                        });
                    });
                  }}
                >
                  {C.permissionReconnect}
                </button>
              </>
            )}
            {hasSetting && error && (
              <p role="alert" className="ac-error">
                {error}
              </p>
            )}
            {hasSetting && (
              <div role="radiogroup" aria-label={C.permission}>
                {!unavailable &&
                  option?.options.map((item) => (
                    <button
                      type="button"
                      key={item.value}
                      className="permission-choice"
                      role="radio"
                      aria-checked={
                        thread.permissionState === "ready" &&
                        item.value === option.currentValue
                      }
                      onClick={() => {
                        changeReview({
                          owner: thread,
                          choice: item,
                          options: optionsIdentity,
                        });
                        setFailure(null);
                        close();
                      }}
                    >
                      <strong>
                        {item.name}
                        {thread.permissionState === "ready" &&
                          item.value === option.currentValue && (
                            <small>
                              {" "}
                              ✓{" "}
                              {nextMessage
                                ? C.permissionNextMessage
                                : C.permissionSelected}
                            </small>
                          )}
                      </strong>
                      {item.description && <span>{item.description}</span>}
                    </button>
                  ))}
              </div>
            )}
            {hasSetting && (
              <p className="workspace-control-note">{scopeNote}</p>
            )}
            {showRules && connectionId && !blocked && !rulesBlocked && (
              <PermissionRules
                key={JSON.stringify([
                  thread.key,
                  thread.agentId,
                  thread.cwd,
                  thread.nativeSessionId,
                  connectionId,
                  thread.serviceContext,
                ])}
                thread={thread}
                connectionId={connectionId}
              />
            )}
          </>
        )}
      </WorkspacePopover>
      {hasSetting && choice && (
        <WorkspaceDialog
          title={C.permissionConfirm}
          onClose={() => changeReview(null)}
        >
          <p>
            <strong>{choice.name}</strong>
          </p>
          {(choice.description ?? option?.description) && (
            <p>{choice.description ?? option?.description}</p>
          )}
          <p className="workspace-control-note">{scopeNote}</p>
          {(error || staleChoice) && (
            <p role="alert" className="ac-error">
              {staleChoice ? C.permissionChanged : error}
            </p>
          )}
          <div className="workspace-dialog-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => changeReview(null)}
            >
              {LIBRARY.cancel}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked || Boolean(staleChoice) || unavailable}
              onClick={() => void apply()}
            >
              {thread.permissionState === "changing"
                ? C.permissionChanging
                : nextMessage
                  ? C.permissionApplyNext
                  : C.permissionApply}
            </button>
          </div>
        </WorkspaceDialog>
      )}
    </>
  );
}
