import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptSearchContext } from "./transcript-search";
import { MessageContent } from "./MessageContent";
import { UserMessageContent } from "./UserMessageContent";
import { CompactionCard } from "./CompactionCard";
import type { CompactionView } from "../runtime/compaction";
const attachments = Array.from({ length: 4 }, (_, i) => ({
  name: `file-${i}`,
  text: `loaded-attachment-${i}`,
}));
it("materializes the fourth attachment's loaded text while search is active", () => {
  const html = renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={true}>
      <MessageContent source={{}} text="body" attachments={attachments} />
    </TranscriptSearchContext.Provider>,
  );
  expect(html).toContain("loaded-attachment-3");
  expect(html).toContain("data-find-block");
});
it("search materialization never introduces image or audio decoders", () => {
  const media = [
    {
      name: "image",
      kind: "image" as const,
      mimeType: "image/png",
      data: "AAAA",
    },
    {
      name: "audio",
      kind: "audio" as const,
      mimeType: "audio/wav",
      data: "AAAA",
    },
  ];
  const html = renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={true}>
      <MessageContent source={{}} text="body" attachments={media} />
    </TranscriptSearchContext.Provider>,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<audio");
});
it("registers ordinary user text separately from historical embedded image data", () => {
  const html = renderToStaticMarkup(
    <UserMessageContent
      historical
      text="before [@image](data:image/png;base64,AAAA) after"
    />,
  );
  expect(html).toMatch(/data-find-block[^>]*>before /);
  expect(html).not.toContain("base64,AAAA");
});
it("registers an already loaded compaction summary even while folded", () => {
  const item = {
    id: "compact",
    kind: "compaction",
    status: "completed",
    summary: [{ type: "text", text: "loaded summary" }],
    details: {},
    summaryDetails: [],
  } as unknown as CompactionView;
  const html = renderToStaticMarkup(<CompactionCard item={item} />);
  expect(html).toContain("data-find-block");
  expect(html).toContain("loaded summary");
});
