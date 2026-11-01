import type { useWorkPolicy } from "../runtime/work_policy";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { SENDING_STRINGS as SEND } from "../runtime/sending_strings";
import { ArchivedWorkLocationNotice } from "./ArchivedWorkLocationNotice";
import { ErrorNotice } from "./ErrorNotice";
import { ERROR_STRINGS } from "../runtime/error_strings";

export function ComposerWorkNotice({
  message,
  detail,
  showAction,
  work,
  workAgentId,
  cwd,
  active,
  archiveHandled,
  onGoSettings,
}: {
  message: string;
  detail?: string;
  showAction: boolean;
  work: ReturnType<typeof useWorkPolicy>;
  workAgentId: string | null;
  cwd: string | null;
  active: boolean;
  archiveHandled: boolean;
  onGoSettings: () => void;
}) {
  const actions = (
    <>
      {workAgentId && work.ready && !work.enabled(workAgentId) && (
        <button
          type="button"
          className="btn btn-ghost"
          title={
            work.locationEnabled === false
              ? `${cwd}\n${SEND.resumeHint}`
              : (cwd ?? undefined)
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
        <button type="button" className="btn btn-ghost" onClick={work.retry}>
          {STRINGS.service.retry}
        </button>
      )}
      {showAction && (
        <button type="button" className="btn btn-text" onClick={onGoSettings}>
          {STRINGS.empty.goSettings}
        </button>
      )}
    </>
  );
  // Do not replace unrelated permission, configuration or send errors.
  return message === STRINGS.repair.workLoadFailed ||
    message === ERROR_STRINGS.workDirectoryUnavailable ||
    message === STRINGS.repair.reconnectFailed ? (
    <ArchivedWorkLocationNotice
      cwd={cwd}
      active={active}
      archiveHandled={archiveHandled}
      message={message}
      detail={detail}
    >
      {actions}
    </ArchivedWorkLocationNotice>
  ) : (
    <ErrorNotice message={message} detail={detail}>
      {actions}
    </ErrorNotice>
  );
}
