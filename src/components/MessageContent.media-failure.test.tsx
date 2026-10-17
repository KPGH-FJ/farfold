import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments } from "./MessageContent";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";

const state = vi.hoisted(() => ({
  kind: "image",
  failed: true,
  blocked: false,
}));
vi.mock("./transcript-search", () => ({
  useSearchExpansion: () => ({
    open: true,
    userOpen: true,
    materialized: true,
    ref: () => {},
    onToggle: () => {},
    choose: () => {},
  }),
}));
vi.mock("../runtime/use_message_media_budget", () => ({
  useMessageMediaPreview: () => ({
    admission: {
      status: "available",
      media: { kind: state.kind, src: "data:image/png;base64,eA==" },
    },
    media: null,
    failed: state.failed,
    budgetRejected: state.blocked,
    pending: false,
    fail: () => {},
    retry: () => {},
  }),
}));

it.each([
  ["image", true, false, S.imageFailed],
  ["audio", true, false, S.audioFailed],
  ["image", false, true, S.mediaBudgetReached],
] as const)(
  "keeps %s failure and explicit retry readable without a live media source",
  (kind, failed, blocked, message) => {
    Object.assign(state, { kind, failed, blocked });
    const attachment = {
      name: "Original name",
      uri: "file:///controlled/original",
      text: "Original readable text",
      data: "eA==",
      mimeType: kind === "image" ? "image/png" : "audio/wav",
    };
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[attachment]} />,
    );
    expect(html).toContain(message);
    expect(html).toContain(S.retryMedia);
    expect(html).toContain('role="status"');
    expect(html).toContain("Original name");
    expect(html).toContain("file:///controlled/original");
    expect(html).toContain("Original readable text");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("data:image");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);
