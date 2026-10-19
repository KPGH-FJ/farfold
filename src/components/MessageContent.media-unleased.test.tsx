import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";

const state = vi.hoisted(() => ({ pending: false, budgetRejected: false }));
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
    admission: null,
    media: null,
    failed: false,
    pending: state.pending,
    budgetRejected: state.budgetRejected,
    fail: () => {},
    retry: () => {},
  }),
}));
import { MessageAttachments } from "./MessageContent";

// UI-only contract at the unleased boundary. The common hook tests use the real
// admission and pool; this SSR check neither commits effects nor decodes media.
it.each([
  [true, false, S.mediaPreparing],
  [false, true, S.mediaBudgetReached],
] as const)(
  "keeps pending=%s quota=%s feedback distinct from unsupported content",
  (pending, budgetRejected, message) => {
    Object.assign(state, { pending, budgetRejected });
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          {
            name: "Original WAV",
            mimeType: "audio/wav",
            data: "AAAA",
            text: "Original text",
          },
        ]}
      />,
    );
    expect(html).toContain(message);
    expect(html).not.toContain(S.previewUnavailable);
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("data:audio");
    expect(html).toContain("Original text");
  },
);
