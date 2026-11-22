import {
  ZERO_SEND_STRINGS as S,
  type ZeroSendAccess,
} from "../runtime/conversation_access";

export function ConversationAccessNotice({
  access,
}: {
  access: ZeroSendAccess;
}) {
  const receipt = access.receipt;
  return (
    <div className="workspace-request-alert" role="status">
      <span>
        {receipt ? (
          <>
            {S.receipt}{" "}
            {S.selection(receipt.provider, receipt.model, receipt.effort)}
          </>
        ) : (
          S.receiptPending
        )}
      </span>
    </div>
  );
}
