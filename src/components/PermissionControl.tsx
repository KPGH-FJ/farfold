import { useEffect, useState } from "react";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import {
  configValueLabel,
  hasActiveTools,
  threads,
  type ConfigChoice,
  type ThreadState,
} from "../runtime/sessions";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { LIBRARY } from "../runtime/library_strings";
import { uiError } from "../runtime/ui_error";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspacePopover } from "./WorkspacePopover";

/** Only the access layer can identify a verified permission setting. */
export function PermissionControl({ thread }: { thread: ThreadState }) {
  const [choice, setChoice] = useState<ConfigChoice | null>(null);
  const [reviewedOptions, setReviewedOptions] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChoice(null);
    setError(null);
  }, [thread.key]);
  const option = thread.configOptions.find(
    (item) => item.id === thread.permissionConfigId,
  );
  if (!thread.permissionConfigId) return null;
  const unavailable =
    !option || option.type !== "select" || !option.options.length;
  const optionsIdentity = JSON.stringify({
    description: option?.description,
    options: option?.options,
  });
  const staleChoice = choice && reviewedOptions !== optionsIdentity;
  const blocked =
    thread.configuring ||
    thread.running ||
    hasActiveTools(thread) ||
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
    if (!choice || blocked || !option || unavailable) return;
    if (
      staleChoice ||
      !option.options.some((item) => item.value === choice.value)
    ) {
      setError(C.permissionChanged);
      return;
    }
    setError(null);
    try {
      await threads.setConfig(thread.key, option.id, choice.value);
      if (threads.thread(thread.key)?.permissionState !== "ready")
        throw new Error(C.permissionFailure);
      setChoice(null);
    } catch (reason) {
      setError(uiError(reason, C.permissionFailure));
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
              {C.permissionShort} · {label}
            </span>
          </>
        }
        disabled={blocked}
      >
        {(close) => (
          <>
            {thread.permissionState === "required" && (
              <p className="workspace-control-note">
                {C.permissionRequiredNote}
              </p>
            )}
            {thread.permissionState === "unknown" && (
              <p className="workspace-control-note">
                {C.permissionUnknownNote}
              </p>
            )}
            {unavailable && (
              <>
                <p className="workspace-control-note">
                  {C.permissionUnavailable}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={blocked}
                  onClick={() => {
                    setError(null);
                    void threads
                      .reconnect(thread.key)
                      .catch((reason) =>
                        setError(uiError(reason, C.permissionFailure)),
                      );
                  }}
                >
                  {C.permissionReconnect}
                </button>
              </>
            )}
            {error && (
              <p role="alert" className="ac-error">
                {error}
              </p>
            )}
            {!unavailable &&
              option?.options.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className="permission-choice"
                  onClick={() => {
                    setChoice(item);
                    setReviewedOptions(optionsIdentity);
                    setError(null);
                    close();
                  }}
                >
                  <strong>{item.name}</strong>
                  {item.description && <span>{item.description}</span>}
                </button>
              ))}
            <p className="workspace-control-note">{C.permissionScope}</p>
          </>
        )}
      </WorkspacePopover>
      {choice && (
        <WorkspaceDialog
          title={C.permissionConfirm}
          onClose={() => setChoice(null)}
        >
          <p>
            <strong>{choice.name}</strong>
          </p>
          {(choice.description ?? option?.description) && (
            <p>{choice.description ?? option?.description}</p>
          )}
          <p className="workspace-control-note">{C.permissionScope}</p>
          {(error || staleChoice) && (
            <p role="alert" className="ac-error">
              {staleChoice ? C.permissionChanged : error}
            </p>
          )}
          <div className="workspace-dialog-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setChoice(null)}
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
                : C.permissionApply}
            </button>
          </div>
        </WorkspaceDialog>
      )}
    </>
  );
}
