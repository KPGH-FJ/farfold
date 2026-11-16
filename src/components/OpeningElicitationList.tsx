import { useSyncExternalStore } from "react";
import { openingInquiries } from "../runtime/opening_inquiries";
import { INQUIRY as S } from "../runtime/elicitation_strings";
import { ElicitationCard } from "./ElicitationCard";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { ApprovalCard } from "./thread-items";
import { DecisionLine } from "./PermissionDecisionLine";

export function OpeningElicitationList({
  agents,
}: {
  agents: readonly { id: string; name: string }[];
}) {
  const list = useSyncExternalStore(
    openingInquiries.subscribe,
    openingInquiries.getSnapshot,
  );
  const view = list[0];
  if (!view) return null;
  const owner = openingInquiries.owner(view.id);
  if (!owner) return null;
  const agent = agents.find((a) => a.id === view.agentId)?.name ?? view.agentId;
  return (
    <WorkspaceDialog
      title={S.openingTitle}
      onClose={() => {
        owner.retire();
        openingInquiries.dismiss(view.id);
      }}
    >
      <div className="workspace-dialog-body">
        <p>
          <strong>{agent}</strong>
        </p>
        <p className="text-secondary">{view.cwd}</p>
        {!view.ended && <p>{S.openingCancel}</p>}
        {view.notice && <p role="status">{view.notice}</p>}
        {view.details !== undefined && (
          <details>
            <summary>{S.details}</summary>
            <pre>{JSON.stringify(view.details, null, 2)}</pre>
          </details>
        )}
        {view.requests.map((request) => (
          <ElicitationCard
            key={request.requestId}
            request={request}
            disabled={view.ended}
            agentName={agent}
            onChange={(name, value) =>
              owner.edit(request.requestId, name, value)
            }
            onRespond={(action, values) => {
              void owner.reply(request.requestId, action, values);
            }}
          />
        ))}
        {view.permissions.map((permission) => (
          <div key={permission.requestId}>
            {permission.error && <p role="alert">{permission.error}</p>}
            {permission.decision ? (
              <DecisionLine
                decision={permission.decision}
                submitting={
                  permission.status === "submitting" ||
                  (permission.status === "pending" &&
                    !permission.decision.undoable)
                }
                onUndo={() => owner.undoPermission(permission.requestId)}
              />
            ) : (
              <ApprovalCard
                title={permission.title}
                kind={permission.kind}
                locations={permission.locations}
                rawInput={permission.toolCallSnapshot?.rawInput}
                options={
                  permission.status === "pending" ? permission.options : []
                }
                disabled={view.ended || permission.status !== "pending"}
                onPick={(option) =>
                  owner.decidePermission(permission.requestId, option.optionId)
                }
              />
            )}
            <button
              type="button"
              className="btn"
              onClick={() => owner.cancelPermission(permission.requestId)}
            >
              {S.cancel}
            </button>
          </div>
        ))}
      </div>
    </WorkspaceDialog>
  );
}
