import type { describeSessionOpening } from "../runtime/session-opening";

export function SessionOpeningPanel({
  opening,
}: {
  opening: ReturnType<typeof describeSessionOpening>;
}) {
  return (
    <div className="session-opening" role="status">
      <h2>{opening.action}</h2>
      <p>{opening.title}</p>
      {opening.projectPath && (
        <dl>
          <dt>Project · Working Copy</dt>
          <dd>{opening.projectPath}</dd>
        </dl>
      )}
      <p>正在核对原生会话与工作目录，完成后显示模型、历史和草稿。</p>
    </div>
  );
}
