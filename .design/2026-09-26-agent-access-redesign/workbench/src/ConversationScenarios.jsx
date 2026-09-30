import React from "react";
import {
  ArrowUpRight,
  BookOpen,
  CaretRight,
  CheckCircle,
  Copy,
  FileText,
} from "@phosphor-icons/react";
import { Badge, Button } from "./ui";

const document = (path, text) => ({
  path,
  label: path.split("/").pop(),
  adds: 0,
  dels: 0,
  lines: text.split("\n").map((line) => ["ctx", line]),
});
const SCENARIOS = {
  travel: {
    intro:
      "我会把节奏放慢一点，每天留出休息和临时调整的时间。先整理你的偏好，再把行程收成一份容易查看的安排。",
    prompt:
      "想去京都待五天，不想赶景点。帮我安排一个松弛一点的行程，住哪里也一起考虑。",
    steps: [
      "整理人数、节奏和出行偏好",
      "按区域安排每天的活动",
      "补充雨天替代与出发前待确认项",
    ],
    question: "这趟旅行更想怎么安排？",
    questionNote: "先确认节奏，后面的安排会更贴合你。",
    options: [
      {
        id: "existing",
        title: "轻松一点，每天两三个地方",
        detail: "留出午后休息和临时调整的空间。",
      },
      {
        id: "explore",
        title: "先看看两种节奏",
        detail: "给出轻松版和充实版，选好后再细化。",
      },
    ],
    notePlaceholder: "同行人数、出发月份，或特别想去的地方…",
    title: "京都五日，留一点空白",
    paragraphs: [
      "以同一区域内的活动为主，把移动安排在一天的开始或结束。下面是用于讨论节奏的示例行程，具体日期、交通和开放时间待你确定后再核对。",
      "住宿先按交通方便、夜间安静、连续入住不换酒店来筛选；等预算和日期明确后，再比较具体区域与房源。",
    ],
    sections: [
      {
        title: "第一天 · 慢慢进入旅行",
        text: "抵达与入住 → 酒店附近散步 → 早一点吃晚餐。不给第一天安排必须赶到的活动。",
      },
      {
        title: "第二天 · 一片区域，半天留白",
        text: "上午安排一个主要去处，午饭后休息；傍晚再选附近的街巷散步。下雨时换成室内活动。",
      },
      {
        title: "第三天 · 留给喜欢的地方",
        text: "重访前两天喜欢的区域，或安排一个短途活动。下午留给咖啡馆、阅读或休息，不额外赶路。",
      },
      {
        title: "第四天 · 让当天的心情决定",
        text: "预留一整天的弹性：天气好就选一处户外活动，下雨则逛室内空间。也可以留在住宿附近，慢慢补上想做的小事。",
      },
      {
        title: "第五天 · 从容收尾",
        text: "早餐后在附近走走，按返程时间安排退房和取行李。给前往车站或机场的交通留足余量，不再加必须打卡的景点。",
      },
    ],
    confirmation:
      "接下来只需要确认：出发日期、同行人数，以及是否有行动不便的家人。",
    files: [
      document(
        "京都五日行程.md",
        "# 京都五日行程（讨论稿）\n\n第一天：抵达、入住、附近散步\n第二天：一片区域内活动，午后留白\n第三天：重访喜欢的地方，或选一项短途活动\n第四天：按天气和心情灵活安排，保留休息时间\n第五天：附近散步、退房与从容返程\n\n住宿：优先考虑交通方便、夜间安静、连续入住；预算与日期明确后再比较区域和房源。\n待确认：出发日期、同行人数、步行接受程度。\n交通、费用和开放时间尚未核对。",
      ),
    ],
  },
  writing: {
    intro:
      "我先读一遍现有材料，保留你的语气，把重点和段落顺序理清楚。修改会围绕读者真正需要知道的内容。",
    prompt: "帮我把这篇介绍改得自然一点，保留信息，别写得像宣传稿。",
    steps: [
      "阅读现有材料与表达要求",
      "梳理重点、段落与读者疑问",
      "整理一版可继续修改的文字",
    ],
    question: "这篇文字主要给谁看？",
    questionNote: "读者不同，信息顺序和解释的深浅也会不同。",
    options: [
      {
        id: "existing",
        title: "第一次接触的读者",
        detail: "少一点术语，先说清楚用途和具体例子。",
      },
      {
        id: "explore",
        title: "先看两个开头方向",
        detail: "分别给出直接说明和场景切入，再选择一种。",
      },
    ],
    notePlaceholder: "读者背景、发布位置，或希望保留的原句…",
    title: "把想说的事，说清楚",
    paragraphs: [
      "我们常常同时推进几件事：找资料、写方案，也会顺手处理一个待办。真正打断节奏的，往往是反复找入口和确认进度。",
      "这个工具把这些事情放在一个清楚的工作空间里。你可以先描述想做什么，在需要决定的地方给出选择，再回到结果继续修改。",
      "它适合日常那些不一定复杂、却需要来回沟通的工作。先从一件具体的小事开始，看看这种方式是否适合你。",
    ],
    sections: [],
    confirmation:
      "这一版先保留平实的语气。下一步可以继续压缩篇幅，或补一个与你的读者更接近的例子。",
    files: [
      document(
        "介绍文案-讨论稿.md",
        "# 介绍文案（讨论稿）\n\n我们常常同时推进几件事：找资料、写方案，也会顺手处理一个待办。真正打断节奏的，往往是反复找入口和确认进度。\n\n这个工具把这些事情放在一个清楚的工作空间里。你可以先描述想做什么，在需要决定的地方给出选择，再回到结果继续修改。\n\n先从一件具体的小事开始，看看这种方式是否适合你。",
      ),
    ],
  },
};
export const scenarioFor = (task) => SCENARIOS[task.demoKind] || null;
export const previewKindFor = (text = "", preferred) => {
  if (
    /旅行|旅游|行程|出游|出行|游玩|目的地|度假|景点|机票|酒店|trip|travel|itinerary/i.test(
      text,
    )
  )
    return "travel";
  if (
    /写作|写一篇|写一封|文案|文章|改写|润色|措辞|邮件|介绍|开头|小说|故事|段落|write|writing|rewrite|draft/i.test(
      text,
    )
  )
    return "writing";
  if (["travel", "writing"].includes(preferred)) return preferred;
  return "general";
};
export const previewFilesFor = (kind) => [
  document(
    kind === "travel"
      ? "旅行偏好.md"
      : kind === "writing"
        ? "文字草稿.md"
        : "参考资料.md",
    "示例附件：用于预览添加文件的交互。",
  ),
];
export const previewIntroFor = (kind) =>
  kind === "travel"
    ? "先把目的地、时间和想要的节奏放在一起，行程会更容易取舍。"
    : kind === "writing"
      ? "先确定读者和想表达的重点，再调整结构与措辞。"
      : "先把想得到的结果说清楚，再把它拆成容易确认的几步。";
export function PreviewResponse({ kind = "general", attachments = [] }) {
  const replies = {
    travel: {
      title: "先把行程节奏定下来",
      intro: "可以先做一版留有余地的安排，再根据你的偏好细化。",
      points: [
        "每天围绕一片区域，安排一两项主要活动，少来回赶路。",
        "把交通、用餐和休息留出时间，同时准备一个雨天备选。",
        "出发日期和人数确定后，再核对开放时间、费用与交通。",
      ],
      next: "接着可以补充目的地、天数，以及更想逛城市、亲近自然，还是轻松休息。",
    },
    writing: {
      title: "先让重点更清楚",
      intro: "可以从信息顺序和语气入手，把这段文字整理得更自然。",
      points: [
        "第一段先说清楚最重要的一件事，让读者知道为什么继续读。",
        "每段保留一个重点，用具体描述替换空泛的修饰。",
        "结尾落到读者需要记住的内容，或接下来可以做的事。",
      ],
      next: "你可以贴上原文，再补一句给谁看、用在哪里，以及哪些表述一定要保留。",
    },
    general: {
      title: "我们可以从这里开始",
      intro: "先整理一版可以讨论的内容，再根据你的反馈继续推进。",
      points: [
        "明确最后想得到什么：一份安排、一段文字、一个比较，或具体的处理结果。",
        "把已有材料与必须遵守的条件放在一起，减少来回补充。",
        "先处理最重要的一部分，需要你决定时再确认。",
      ],
      next: "继续补充一个具体目标，或者添加相关材料，就能开始下一步讨论。",
    },
  };
  const reply = replies[kind] || replies.general;
  return (
    <section className="conv-result conv-document-result">
      <div className="conv-result-label">
        <CheckCircle size={17} />
        <strong>示例回复</strong>
      </div>
      <h2>{reply.title}</h2>
      <p>{reply.intro}</p>
      <ul>
        {reply.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <p className="conv-result-next">{reply.next}</p>
      {attachments.length > 0 && (
        <p>附件已保留在消息中；此预览没有读取附件内容。</p>
      )}
      <small className="conv-card-foot">
        这是交互预览中的示例内容，尚未连接 Agent，也没有查询实时信息或执行操作。
      </small>
    </section>
  );
}
export function ProgressSummary({
  children,
  text = "查看处理过程",
  count = 3,
}) {
  return (
    <details className="conv-progress-disclosure">
      <summary>
        <BookOpen size={15} />
        <span>{text}</span>
        <small>{count} 步</small>
        <CaretRight size={13} />
      </summary>
      <div className="conv-steps">{children}</div>
    </details>
  );
}
export function ScenarioSteps({ scenario, status }) {
  const summary =
    {
      question: "已整理需求，等待你确认",
      running: "正在整理内容",
      done: "已整理内容",
      stopped: "整理已停止",
      unknown: "整理结果待确认",
      recovery: "等待恢复后继续",
    }[status] || "查看整理过程";
  const remaining =
    {
      stopped: "已停止",
      unknown: "待确认",
      recovery: "等待恢复",
    }[status] || "待继续";
  return (
    <ProgressSummary text={summary}>
      {scenario.steps.map((step, index) => (
        <div className="conv-generic-step" key={step}>
          <span>{index + 1}</span>
          <p>{step}</p>
          <small>
            {status === "done" ? "已完成" : index === 0 ? "已阅读" : remaining}
          </small>
        </div>
      ))}
    </ProgressSummary>
  );
}
export function ScenarioResult({ scenario, task, openPane, copy }) {
  const plan = task.resultMode === "plan";
  return (
    <section className="conv-result conv-document-result">
      <div className="conv-result-label">
        <CheckCircle size={17} />
        <strong>{plan ? "方向草案" : "整理好了"}</strong>
        <Badge>示例</Badge>
      </div>
      <h2>
        {plan
          ? task.demoKind === "travel"
            ? "两种节奏，先选一种"
            : "两个开头，先选一种"
          : scenario.title}
      </h2>
      {plan ? (
        <>
          <div className="conv-prose-section">
            <h3>{task.demoKind === "travel" ? "轻松版" : "直接说明"}</h3>
            <p>
              {task.demoKind === "travel"
                ? "每天围绕一片区域安排两项活动，中午留出休息时间。适合和家人慢慢走。"
                : "先用两句话交代这是什么、能帮读者做什么，再补具体的使用场景。"}
            </p>
          </div>
          <div className="conv-prose-section">
            <h3>{task.demoKind === "travel" ? "充实版" : "场景切入"}</h3>
            <p>
              {task.demoKind === "travel"
                ? "上午和下午各安排一项主要活动，傍晚根据体力决定是否继续散步。"
                : "从读者熟悉的一件小事写起，在他们理解问题后再介绍解决方式。"}
            </p>
          </div>
          <p className="conv-result-next">选好方向后再细化。待发消息已暂停。</p>
        </>
      ) : (
        <>
          {scenario.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {scenario.sections.map((section) => (
            <div className="conv-prose-section" key={section.title}>
              <h3>{section.title}</h3>
              <p>{section.text}</p>
            </div>
          ))}
          <p className="conv-result-next">{scenario.confirmation}</p>
          <button
            className="conv-document-link"
            onClick={() => openPane("files", 0)}
          >
            <FileText size={20} />
            <span>
              <strong>{scenario.files[0].label}</strong>
              <small>打开完整内容</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        </>
      )}
      <div className="conv-result-footer">
        <Button
          kind="text"
          onClick={() =>
            copy(
              plan
                ? `${scenario.question}\n${scenario.options.map((option) => `${option.title}：${option.detail}`).join("\n")}`
                : scenario.files[0].lines.map(([, line]) => line).join("\n"),
            )
          }
        >
          <Copy size={14} />
          复制内容
        </Button>
      </div>
    </section>
  );
}
