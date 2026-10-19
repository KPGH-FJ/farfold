import { invoke } from "@tauri-apps/api/core";

/** This decoder is only used on the Farfold progress channel, never raw ACP. */
export interface HistoryDeliveryReceipt {
  receiptId: number;
  openToken: string;
}
export function historyDeliveryReceipt(value: unknown, token: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).length !== 2 ||
    receipt.openToken !== token ||
    typeof receipt.receiptId !== "number" ||
    !Number.isSafeInteger(receipt.receiptId) ||
    receipt.receiptId <= 0
  )
    return;
  return { receiptId: receipt.receiptId, openToken: token };
}
export async function acknowledgeHistoryDelivery(
  agentId: string,
  receipt: HistoryDeliveryReceipt,
) {
  const value = await invoke<unknown>("session_history_delivery_ack", {
    agentId,
    ...receipt,
  });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("unconfirmed delivery retirement");
  const reply = value as Record<string, unknown>;
  if (
    Object.keys(reply).length !== 3 ||
    reply.openToken !== receipt.openToken ||
    reply.receiptId !== receipt.receiptId ||
    (reply.outcome !== "acknowledged" && reply.outcome !== "notRetained")
  )
    throw new Error("unconfirmed delivery retirement");
}
