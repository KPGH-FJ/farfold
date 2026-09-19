/**
 * 产物抽屉：右侧可拖宽面板，列出本轮/全部会话产物 ——
 * fileDiff 卡（unified diff 红绿行）、agent 报告的 diff 卡、
 * 终端产物卡（输出尾部等宽文本）。数据来自 ThreadState.artifacts
 * 与 tool_call diff 内容（见 paneCards）。
 */
import { useCallback, useRef, useState } from "react";
import {
  paneCards,
  threads,
  type PaneCard,
  type TerminalTail,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { DiffView } from "./thread-items";

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 480;
/** fileDiff 卡最多渲染的 unified diff 行数。 */
const DIFF_LINE_CAP = 200;
/** 终端卡渲染的输出尾部行数。 */
const TERMINAL_LINE_CAP = 200;

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "a-meta";
  if (line.startsWith("@@")) return "a-hunk";
  if (line.startsWith("+")) return "a-add";
  if (line.startsWith("-")) return "a-del";
  return "a-ctx";
}

function FileDiffCard({ card }: { card: Extract<PaneCard, { kind: "diff" }> }) {
  const lines = card.diff.split("\n");
  const clipped = lines.length > DIFF_LINE_CAP;
  const shown = clipped ? lines.slice(0, DIFF_LINE_CAP) : lines;
  return (
    <div className="a-card">
      <div className="a-card-h">
        <span className="a-path">{card.path}</span>
        <span className="a-sub">
          {card.oldSize === 0
            ? STRINGS.artifacts.diffNew
            : STRINGS.artifacts.diffEdit}
          {" · "}
          {STRINGS.artifacts.sizeDelta(card.oldSize, card.newSize)}
        </span>
      </div>
      <div className="a-diff">
        {shown.map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line}
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

function ToolDiffCard({
  card,
}: {
  card: Extract<PaneCard, { kind: "toolDiff" }>;
}) {
  return (
    <div className="a-card">
      <DiffView
        path={card.path}
        oldText={card.oldText}
        newText={card.newText}
      />
    </div>
  );
}

function TerminalCard({
  card,
  tail,
}: {
  card: Extract<PaneCard, { kind: "terminal" }>;
  tail: TerminalTail | undefined;
}) {
  const all = (tail?.text ?? "").split("\n");
  const clipped = all.length > TERMINAL_LINE_CAP;
  const shown = clipped ? all.slice(all.length - TERMINAL_LINE_CAP) : all;
  return (
    <div className="a-card">
      <div className="a-card-h">
        <span className="a-path">{card.title || card.terminalId}</span>
        <span className="a-sub">
          {tail?.exit != null
            ? STRINGS.artifacts.terminalExited(tail.exit)
            : STRINGS.artifacts.terminalRunning}
        </span>
      </div>
      {(tail?.truncated || clipped) && (
        <div className="a-note">{STRINGS.artifacts.terminalTruncated}</div>
      )}
      <pre className="a-term">{shown.join("\n")}</pre>
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
  const lastSettled = [...thread.items]
    .reverse()
    .find((item) => item.kind === "settled");
  const roundCount =
    lastSettled && lastSettled.kind === "settled"
      ? lastSettled.artifactCount
      : cards.length;

  return (
    <aside className="artifact-pane" style={{ width }}>
      <div
        className="a-drag"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onDragStart}
      />
      <div className="a-head">
        <span className="a-title">{STRINGS.artifacts.title(roundCount)}</span>
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
              return <FileDiffCard key={i} card={card} />;
            case "toolDiff":
              return <ToolDiffCard key={i} card={card} />;
            case "terminal":
              return (
                <TerminalCard
                  key={i}
                  card={card}
                  tail={thread.terminalTails[card.terminalId]}
                />
              );
          }
        })}
      </div>
    </aside>
  );
}
