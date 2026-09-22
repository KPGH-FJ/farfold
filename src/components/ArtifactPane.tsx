/**
 * 产物抽屉：右侧可拖宽面板，列出会话产物 ——
 * diff 卡（tool_call diff 内容：旧文本行为删除、新文本行为新增）与
 * 命令卡（execute 调用的输出尾部等宽文本）。数据全部来自 thread
 * items（见 paneCards）。
 */
import { useCallback, useRef, useState } from "react";
import { COMMAND_OUTPUT_CAP } from "../runtime/artifacts";
import {
  paneCards,
  threads,
  type PaneCard,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 480;
/** diff 卡最多渲染的旧/新文本行数（合计）。 */
const DIFF_LINE_CAP = 200;
/** 命令卡渲染的输出尾部行数。 */
const TERMINAL_LINE_CAP = 200;

function DiffCard({ card }: { card: Extract<PaneCard, { kind: "diff" }> }) {
  const lines = [
    ...(card.oldText ? card.oldText.split("\n") : []).map((text) => ({
      cls: "a-del",
      text: `− ${text}`,
    })),
    ...card.newText.split("\n").map((text) => ({
      cls: "a-add",
      text: `+ ${text}`,
    })),
  ];
  const clipped = lines.length > DIFF_LINE_CAP;
  const shown = clipped ? lines.slice(0, DIFF_LINE_CAP) : lines;
  return (
    <div className="a-card">
      <div className="a-card-h">
        <span className="a-path">{card.path}</span>
        <span className="a-sub">
          {card.oldText === null
            ? STRINGS.artifacts.diffNew
            : STRINGS.artifacts.diffEdit}
        </span>
      </div>
      <div className="a-diff">
        {shown.map((line, i) => (
          <div key={i} className={line.cls}>
            {line.text}
          </div>
        ))}
        {clipped && (
          <div className="a-ctx">
            {STRINGS.artifacts.moreLines(lines.length - shown.length)}
          </div>
        )}
      </div>
    </div>
  );
}

function CommandCard({
  card,
}: {
  card: Extract<PaneCard, { kind: "command" }>;
}) {
  const all = card.output ? card.output.split("\n") : [];
  const clipped = all.length > TERMINAL_LINE_CAP;
  const shown = clipped ? all.slice(-TERMINAL_LINE_CAP) : all;
  const truncated = clipped || card.output.length >= COMMAND_OUTPUT_CAP;
  return (
    <div className="a-card">
      <div className="a-card-h">
        <span className="a-path">{card.title}</span>
      </div>
      {truncated && (
        <div className="a-note">{STRINGS.artifacts.terminalTruncated}</div>
      )}
      {all.length > 0 && <pre className="a-term">{shown.join("\n")}</pre>}
    </div>
  );
}

export function ArtifactPane({ thread }: { thread: ThreadState }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onDragStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      drag.current = { startX: event.clientX, startWidth: width };
      const onMove = (e: MouseEvent) => {
        if (!drag.current) return;
        // Handle sits on the pane's left edge: dragging left widens.
        const delta = drag.current.startX - e.clientX;
        const next = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, drag.current.startWidth + delta),
        );
        setWidth(next);
      };
      const onUp = () => {
        drag.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width],
  );

  const cards = paneCards(thread);

  return (
    <aside className="artifact-pane" style={{ width }}>
      <div
        className="a-drag"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onDragStart}
      />
      <div className="a-head">
        <span className="a-title">{STRINGS.artifacts.title(cards.length)}</span>
        <button
          type="button"
          className="a-close"
          aria-label={STRINGS.artifacts.close}
          onClick={() => threads.closeArtifactPane(thread.key)}
        >
          ×
        </button>
      </div>
      <div className="a-list">
        {cards.length === 0 && (
          <div className="a-empty">{STRINGS.artifacts.empty}</div>
        )}
        {cards.map((card, i) => {
          switch (card.kind) {
            case "diff":
              return <DiffCard key={i} card={card} />;
            case "command":
              return <CommandCard key={i} card={card} />;
          }
        })}
      </div>
    </aside>
  );
}
