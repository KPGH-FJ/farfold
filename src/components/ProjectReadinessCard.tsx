import type { ProjectReadiness, ProjectTrust } from "../runtime/pi";

interface ProjectReadinessCardProps {
  projectPath: string | null;
  readiness: ProjectReadiness | null;
  loading: boolean;
  trust: ProjectTrust;
  providerState: string;
  disabled: boolean;
  onTrust: (value: ProjectTrust) => void;
}

const resourceLabels: Record<
  ProjectReadiness["protectedResources"][number]["kind"],
  string
> = {
  settings: "Pi 设置",
  skill: "项目 Skill",
  extension: "项目 Extension",
  prompt: "提示模板",
  theme: "主题",
  system: "系统提示",
  "append-system": "追加系统提示",
  "agent-skill": "项目 Agent Skill",
};

function trustSummary(trust: ProjectTrust): string {
  if (trust === "approve") return "本次载入项目资源";
  if (trust === "ignore") return "本次不载入受保护项目资源";
  return "遵循 Pi 已保存选择";
}

function resourceSummary(readiness: ProjectReadiness | null): string {
  if (!readiness) return "尚未扫描 Project 本地资源";
  const parts = [
    readiness.contextFiles.length
      ? readiness.contextFiles.join("、")
      : "未发现适用项目指令",
    readiness.protectedResources.length
      ? `${readiness.protectedResources.length} 类受保护项目资源`
      : "未发现受保护项目资源",
  ];
  return parts.join(" · ");
}

export function ProjectReadinessCard({
  projectPath,
  readiness,
  loading,
  trust,
  providerState,
  disabled,
  onTrust,
}: ProjectReadinessCardProps) {
  return (
    <section className="readiness-card" aria-label="开工准备">
      <div className="readiness-summary">
        <strong>准备开工</strong>
        <span>
          {projectPath ? resourceSummary(readiness) : "先选择一个 Project"}
        </span>
      </div>
      <details>
        <summary>查看本次开工信息</summary>
        <dl className="readiness-facts">
          <div>
            <dt>Project</dt>
            <dd title={projectPath ?? undefined}>
              {projectPath ?? "尚未选择"}
            </dd>
          </div>
          <div>
            <dt>适用项目指令</dt>
            <dd>
              {loading
                ? "正在扫描…"
                : readiness?.contextFiles.length
                  ? readiness.contextFiles.join("、")
                  : "未发现"}
            </dd>
          </div>
          <div>
            <dt>受保护项目资源</dt>
            <dd>
              {loading
                ? "正在扫描…"
                : readiness?.protectedResources.length
                  ? readiness.protectedResources
                      .map(
                        (item) =>
                          `${resourceLabels[item.kind]}${item.entries ? ` ${item.entries}` : ""}（${item.sources.join("、")}）`,
                      )
                      .join("、")
                  : "未发现"}
            </dd>
          </div>
          <div>
            <dt>模型状态</dt>
            <dd>{providerState}</dd>
          </div>
        </dl>
        <label className="readiness-trust">
          <span>本次启动策略</span>
          <select
            value={trust}
            disabled={disabled || !projectPath}
            onChange={(event) => onTrust(event.target.value as ProjectTrust)}
          >
            <option value="approve">载入受保护项目资源（仅本次）</option>
            <option value="ignore">不载入受保护项目资源（仅本次）</option>
            <option value="saved">遵循 Pi 已保存选择</option>
          </select>
        </label>
        <p className="readiness-note">
          本卡列出 Project 与父目录的适用指令，以及 Project 根目录可直接发现的
          Pi 受保护资源。选择“不载入”只跳过这些资源，不会限制 Pi
          读写文件或执行命令。
        </p>
      </details>
      <span className="readiness-mode">{trustSummary(trust)}</span>
    </section>
  );
}
