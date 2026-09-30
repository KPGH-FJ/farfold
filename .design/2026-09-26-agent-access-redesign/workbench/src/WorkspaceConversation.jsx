import React from "react";
import {
  ArrowUpRight,
  ChatCircleText,
  CheckCircle,
  Code,
  FileText,
  Globe,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import { Badge, Button } from "./ui";
import { ProgressSummary } from "./ConversationScenarios.jsx";

export function WorkspaceFollowup({ kind }) {
  const replies = {
    review: [
      "这条审阅反馈已收到",
      "先确认对应交互的预期行为，再决定修改范围。右侧仍保留这组改动和原有发现，文件没有改变。",
    ],
    web: [
      "页面调整方向已收到",
      "可以继续讨论布局、文字或阅读节奏。右侧保留当前页面作为比较起点，HTML 和 CSS 尚未改变。",
    ],
    document: [
      "这份文稿的调整要求已收到",
      "原稿和当前修改稿都保留着，可以接着确认哪些表达要保留、哪些段落要压缩。右侧文稿尚未更新。",
    ],
    run: [
      "这项失败的分析要求已收到",
      "接下来应围绕对应断言检查交互路径，再决定调整和复查的范围。右侧仍是原来的输出，没有重新执行测试。",
    ],
  };
  const [title, body] = replies[kind];
  return (
    <section className="conv-result">
      <div className="conv-result-label">
        <CheckCircle size={17} />
        <strong>{title}</strong>
        <Badge>本地示例</Badge>
      </div>
      <p>{body}</p>
      <small className="conv-card-foot">
        此处只预览反馈后的对话状态，没有连接真实 Agent。
      </small>
    </section>
  );
}

export default function WorkspaceConversation({
  kind,
  data,
  panel,
  onSelect,
  onFeedback,
}) {
  data = {
    ...data,
    files: data?.files || [],
    findings: data?.findings || [],
    activities: data?.activities || [],
    tests: data?.tests || [],
  };
  const failed = data.tests?.filter((test) => test.status === "failed") || [];
  return (
    <section className="workspace-conversation">
      <ProgressSummary text="查看整理过程" count={data.activities.length}>
        {data.activities.map((activity, index) => (
          <div className="conv-generic-step" key={activity}>
            <span>{index + 1}</span>
            <p>{activity}</p>
            <small>示例</small>
          </div>
        ))}
      </ProgressSummary>
      <div className="workspace-summary-heading">
        <h2>
          {kind === "review"
            ? "3 条需要关注的反馈"
            : kind === "run"
              ? "2 项通过，2 项需要处理"
              : kind === "web"
                ? "页面已放在右侧"
                : "保留原稿，逐段比较"}
        </h2>
        <Badge>本地示例</Badge>
      </div>
      {kind === "review" ? (
        <div className="workspace-findings">
          {data.findings.map((finding, index) => (
            <article
              key={finding.id}
              className={panel?.finding === finding.id ? "selected" : ""}
            >
              <div className="workspace-finding-title">
                <span>{index + 1}</span>
                <Badge tone={finding.severity === "高" ? "red" : "amber"}>
                  {finding.severity}
                </Badge>
                <h3>{finding.title}</h3>
              </div>
              <p>{finding.detail}</p>
              <div className="workspace-finding-actions">
                <button
                  onClick={() =>
                    onSelect({
                      tab: "diff",
                      file: finding.fileId,
                      line: finding.line,
                      finding: finding.id,
                    })
                  }
                >
                  {data.files
                    .find((file) => file.id === finding.fileId)
                    ?.path?.split("/")
                    .pop() || "文件"}
                  :{finding.line}
                  <ArrowUpRight size={13} />
                </button>
                <Button kind="text" onClick={() => onFeedback(finding.prompt)}>
                  <ChatCircleText size={14} />
                  带回输入
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : kind === "run" ? (
        <div className="workspace-run-findings">
          {failed.map((test) => (
            <article key={test.id}>
              <WarningCircle size={18} />
              <div>
                <strong>{test.name}</strong>
                <p>{test.detail.split("\n")[0]}</p>
                <button
                  onClick={() => onSelect({ tab: "tests", test: test.id })}
                >
                  查看失败详情
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </article>
          ))}
          <Button onClick={() => onSelect({ tab: "logs" })}>
            <TerminalWindow size={16} />
            查看完整输出
          </Button>
        </div>
      ) : (
        <div className="workspace-content-options">
          {(kind === "web"
            ? [
                {
                  tab: "preview",
                  title: "打开网页预览",
                  detail: "真实 HTML / CSS，支持宽度切换",
                  Icon: Globe,
                },
                {
                  tab: "source",
                  title: "查看页面源码",
                  detail: "HTML 与样式分别查看",
                  Icon: Code,
                },
              ]
            : [
                {
                  tab: "compare",
                  title: "逐段对照",
                  detail: "原稿与修改稿一起阅读",
                  Icon: FileText,
                },
                {
                  tab: "preview",
                  title: "只看修改稿",
                  detail: "按文稿排版阅读内容",
                  Icon: CheckCircle,
                },
              ]
          ).map(({ tab, title, detail, Icon }) => (
            <button key={tab} onClick={() => onSelect({ tab })}>
              <Icon size={21} />
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      )}
      {kind === "document" && (
        <p className="workspace-next">
          示例调整：删去抽象的宣传表述，补上具体用法，并把“欢迎反馈”改为可以回答的问题。
        </p>
      )}
      <p className="workspace-example-note">
        本地交互示例 · 内容和输出均为样例，没有读取、修改或运行真实项目。
      </p>
    </section>
  );
}
