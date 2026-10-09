import { expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { CompactionCard } from "./CompactionCard";

it.each(["Enter", " ", "Backspace"])(
  "keeps %s inside the native details without approving the conversation",
  (key) => {
    const card = CompactionCard({
      item: {
        kind: "compaction",
        id: "c",
        compactionId: "c",
        status: "completed",
        summary: [],
        details: {},
        summaryDetails: [],
      },
    });
    const stopPropagation = vi.fn();
    card.props.onKeyDown({
      key,
      stopPropagation,
    } as unknown as KeyboardEvent<HTMLElement>);
    expect(stopPropagation).toHaveBeenCalledOnce();
  },
);
