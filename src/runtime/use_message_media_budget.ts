import { useLayoutEffect, useMemo, useState } from "react";
import type { Attachment } from "./session_types";
import {
  attachmentMediaAdmission,
  attachmentMediaPreviewEligibility,
  type MessageMediaAdmission,
} from "./message_attachments";
import {
  messageMediaBudget,
  type MessageMediaLease,
} from "./message_media_budget";

export function useMessageMediaPreview(
  attachment: Attachment,
  enabled: boolean,
) {
  const eligibility = useMemo(
    () => (enabled ? attachmentMediaPreviewEligibility(attachment) : null),
    [enabled, attachment.data, attachment.mimeType],
  );
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    eligibility: typeof eligibility;
    admission: MessageMediaAdmission | null;
    attempt: number;
    lease: MessageMediaLease | null;
    failed: boolean;
    budgetRejected: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (eligibility?.status !== "eligible") {
      setResult((previous) => (previous === null ? previous : null));
      return;
    }
    const lease = messageMediaBudget.acquire(eligibility.bytes);
    if (!lease) {
      setResult({
        eligibility,
        admission: null,
        attempt,
        lease: null,
        failed: false,
        budgetRejected: true,
      });
      return;
    }
    let admission: MessageMediaAdmission;
    try {
      admission = attachmentMediaAdmission(attachment);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (admission.status !== "available") lease.release();
    setResult({
      eligibility,
      admission,
      attempt,
      lease: admission.status === "available" ? lease : null,
      failed: false,
      budgetRejected: false,
    });
    // Each acquisition still has its own idempotent release. Validation failure,
    // late cleanup and StrictMode replay cannot release another owner's lease.
    return () => lease.release();
  }, [eligibility, attempt, attachment.data]);

  const current =
    result?.eligibility === eligibility && result.attempt === attempt;
  const admission =
    eligibility && eligibility.status !== "eligible"
      ? eligibility
      : current
        ? (result?.admission ?? null)
        : null;
  const available = admission?.status === "available";
  return {
    admission,
    media: available && current && result?.lease ? admission.media : null,
    failed: available && current && !!result?.failed,
    budgetRejected: current && !!result?.budgetRejected,
    pending: eligibility?.status === "eligible" && !current,
    fail: () => {
      if (!current || !result?.lease || result.failed) return;
      result.lease.release();
      setResult((previous) =>
        previous === result
          ? { ...previous, lease: null, failed: true }
          : previous,
      );
    },
    // Releasing another owner never retries this preview automatically.
    retry: () => setAttempt((value) => value + 1),
  };
}
