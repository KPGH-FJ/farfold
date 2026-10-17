import { useLayoutEffect, useMemo, useState } from "react";
import type { Attachment } from "./session_types";
import { attachmentMediaAdmission } from "./message_attachments";
import {
  messageMediaBudget,
  type MessageMediaLease,
} from "./message_media_budget";

export function useMessageMediaPreview(
  attachment: Attachment,
  enabled: boolean,
) {
  const admission = useMemo(
    () => (enabled ? attachmentMediaAdmission(attachment) : null),
    [enabled, attachment.data, attachment.mimeType],
  );
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    admission: typeof admission;
    attempt: number;
    lease: MessageMediaLease | null;
  } | null>(null);

  useLayoutEffect(() => {
    if (admission?.status !== "available") {
      setResult((previous) => (previous === null ? previous : null));
      return;
    }
    // Admission already proved canonical Base64 and the per-file byte limit.
    const data = attachment.data!;
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const lease = messageMediaBudget.acquire((data.length / 4) * 3 - padding);
    setResult({ admission, attempt, lease });
    // Each acquisition has its own idempotent release. A late/StrictMode
    // cleanup cannot free another owner or a later acquisition.
    return () => lease?.release();
  }, [admission, attempt, attachment.data]);

  const current = result?.admission === admission && result.attempt === attempt;
  const available = admission?.status === "available";
  return {
    admission,
    media: available && current && result.lease ? admission.media : null,
    budgetRejected: available && current && !result.lease,
    pending: available && !current,
    // No automatic retry on another preview's release. Only a current visible
    // retry button advances this instance's attempt.
    retry: () => setAttempt((value) => value + 1),
  };
}
