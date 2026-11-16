import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { draftPersistence } from "./draft_storage";
import type { PendingElicitation } from "./session_types";
import { INQUIRY as S } from "./elicitation_strings";

export function readElicitation(
  event: Record<string, unknown>,
): PendingElicitation | null {
  if (typeof event.requestId !== "string" || !event.requestId) return null;
  if (event.mode !== undefined && event.mode !== "form" && event.mode !== "url")
    return null;
  return {
    requestId: event.requestId,
    status: "pending",
    error: null,
    mode: event.mode === "url" ? "url" : "form",
    message: typeof event.message === "string" ? event.message : "",
    schema:
      event.schema &&
      typeof event.schema === "object" &&
      !Array.isArray(event.schema)
        ? (event.schema as Record<string, unknown>)
        : null,
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
    values: {},
    ...(event.mode === "url"
      ? { url: typeof event.url === "string" ? event.url : "" }
      : {}),
    ...(event.owner &&
    typeof event.owner === "object" &&
    !Array.isArray(event.owner)
      ? { owner: structuredClone(event.owner) as Record<string, unknown> }
      : {}),
    ...(event.request !== undefined
      ? { requestSnapshot: structuredClone(event.request) }
      : {}),
  };
}

export function inquiryUrl(raw?: string): URL | null {
  if (
    !raw ||
    raw.length > 16 * 1024 ||
    raw.trim() !== raw ||
    /[\x00-\x1f\x7f-\x9f\\]/.test(raw)
  )
    return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export interface InquiryPorts {
  current: () => boolean;
  canSubmit?: () => boolean;
  changed: () => void;
  remove: (notice?: string) => void;
  sessionId?: string | null;
}

/** Called only by an explicit choice. Opening, local reply submission and the
 * Agent's external completion report never stand in for each other. */
export async function replyToElicitation(
  p: PendingElicitation,
  action: "accept" | "decline" | "cancel",
  values: Record<string, unknown> | undefined,
  ports: InquiryPorts,
): Promise<void> {
  const interrupted =
    action === "accept"
      ? draftPersistence.captureInteractionInterruption()
      : undefined;
  const canSubmit = () => ports.current() && ports.canSubmit?.() !== false;
  if (
    interrupted?.() ||
    !canSubmit() ||
    p.status !== "pending" ||
    (action === "accept" && p.opening)
  )
    return;
  if (p.mode === "url" && action === "accept") {
    if (!inquiryUrl(p.url)) {
      p.error = S.unsafe;
      ports.changed();
      return;
    }
    p.opening = true;
    p.error = null;
    ports.changed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        openUrl(p.url!).then(
          () => "opened" as const,
          () => "failed" as const,
        ),
        new Promise<"unknown">((resolve) => {
          timer = setTimeout(() => resolve("unknown"), 15_000);
        }),
      ]);
      if (!canSubmit() || p.status !== "pending") return;
      if (outcome !== "opened") {
        p.error = outcome === "unknown" ? S.openUnknown : S.openFailed;
        if (outcome === "unknown") p.status = "uncertain";
        return;
      }
    } finally {
      clearTimeout(timer);
      p.opening = false;
      if (canSubmit()) ports.changed();
    }
  }
  // Opening the browser does not revive a choice interrupted by exit.
  if (interrupted?.() || !canSubmit() || p.status !== "pending") return;
  p.status = "submitting";
  p.error = null;
  ports.changed();
  let reply: { status?: string } | undefined;
  try {
    reply = await invoke("session_elicitation_respond", {
      requestId: p.requestId,
      sessionId: ports.sessionId ?? null,
      ...(p.owner ? { requestOwner: p.owner } : {}),
      action,
      content:
        action === "accept" && p.mode !== "url" ? (values ?? p.values) : null,
    });
  } catch {
    reply = { status: "uncertain" };
  }
  // An already issued reply can settle during stop while it still owns this request.
  if (!ports.current()) return;
  if (reply?.status === "submitted") {
    if (p.mode === "url" && action === "accept") {
      p.handoff = "waiting";
      ports.changed();
    } else ports.remove();
  } else if (reply?.status === "expired") ports.remove(S.expired);
  else {
    p.status = reply?.status === "retryable" ? "pending" : "uncertain";
    p.error = p.status === "pending" ? S.replyRetry : S.replyUnknown;
    ports.changed();
  }
}
