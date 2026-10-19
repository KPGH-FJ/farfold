import type { Attachment } from "../runtime/session_types";
import { attachmentMediaAdmission } from "../runtime/message_attachments";

/** Supplied admission state for SSR presentation tests only. Computes the real
 * format result, but does not call the Hook, commit effects, or reserve a lease.
 * Available media stays pending with no element/source; this is not playback or
 * production ordering proof. Real Hook/layout/pool controls remain unmocked. */
export function computedAdmissionForSsr(
  attachment: Attachment,
  enabled: boolean,
) {
  const admission = enabled ? attachmentMediaAdmission(attachment) : null;
  return {
    admission,
    media: null,
    failed: false,
    budgetRejected: false,
    pending: admission?.status === "available",
    fail: () => {},
    retry: () => {},
  };
}
