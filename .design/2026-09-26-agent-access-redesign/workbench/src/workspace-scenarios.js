const cardBefore = `type Props = { title: string; onOpen: () => void };

export function ProjectCard({ title, onOpen }: Props) {
  return <button type="button" onClick={onOpen}>{title}</button>;
}`;
const cardAfter = `type Props = { title: string; onOpen: () => void; disabled?: boolean };

export function ProjectCard({ title, onOpen, disabled }: Props) {
  return (
    <div
      className="project-card"
      onClick={onOpen}
      aria-disabled={disabled}
    >
      <span className="project-title">{title}</span>
      <span className="project-arrow">↗</span>
    </div>
  );
}`;
const cssBefore = `.project-card {
  padding: 16px;
  border: 1px solid #e5e2dc;
  border-radius: 10px;
}
.project-card:focus-visible {
  outline: 2px solid #82705b;
  outline-offset: 3px;
}`;
const cssAfter = `.project-card {
  display: flex;
  justify-content: space-between;
  padding: 16px;
  border: 1px solid #e5e2dc;
  border-radius: 10px;
  cursor: pointer;
}
.project-card:hover {
  background: #f5f3ef;
}
.project-card:focus-visible {
  outline: none;
}`;
const tests = `it("opens a project by mouse", async () => {
  const onOpen = vi.fn();
  render(<ProjectCard title="Notes" onOpen={onOpen} />);
  await user.click(screen.getByText("Notes"));
  expect(onOpen).toHaveBeenCalledOnce();
});`;
const runTests = `it("显示项目名称", () => {
  render(<ProjectCard title="Notes" onOpen={vi.fn()} />);
  expect(screen.getByText("Notes")).toBeVisible();
});

it("鼠标点击打开项目", async () => {
  const onOpen = vi.fn();
  render(<ProjectCard title="Notes" onOpen={onOpen} />);
  await user.click(screen.getByText("Notes"));
  expect(onOpen).toHaveBeenCalledOnce();
});

it("Tab 聚焦后用 Enter 打开", async () => {
  const onOpen = vi.fn();
  render(<ProjectCard title="Notes" onOpen={onOpen} />);
  await user.tab();
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledOnce();
});

it("禁用时不触发打开", async () => {
  const onOpen = vi.fn();
  render(<ProjectCard title="Notes" onOpen={onOpen} disabled />);
  await user.click(screen.getByText("Notes"));
  expect(onOpen).not.toHaveBeenCalled();
});`;
const html = `<main class="page">
  <header><span class="eyebrow">WEEKEND NOTES</span><span class="season">秋日 · 城市散步</span></header>
  <section class="intro"><span class="small">慢一点，也很好</span><h1>给周末留一点空白</h1><p>不用走很远。选一条喜欢的街，把时间留给沿途遇见的小事。</p></section>
  <section class="cards" aria-label="周末安排">
    <article><span class="number">01 / 上午</span><h2>从一杯咖啡开始</h2><p>带上一本还没读完的书，在街角找一个靠窗的位置。</p><span class="tag">无需预约</span></article>
    <article><span class="number">02 / 午后</span><h2>沿着河边慢慢走</h2><p>不设终点。走累了就坐一会儿，让行程跟着心情。</p><span class="tag">约 40 分钟</span></article>
    <article><span class="number">03 / 傍晚</span><h2>带一点喜欢的回家</h2><p>一束花、一张明信片，或一份好吃的晚餐。</p><span class="tag">留给自己</span></article>
  </section>
  <footer><span>三个小安排，一整个自在的周末。</span><a href="#top">回到开头 ↑</a></footer>
</main>`;
const css = `* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: #f6f3ed; color: #363b32; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.page { max-width: 960px; margin: auto; padding: 30px; }
header, footer { display: flex; justify-content: space-between; gap: 20px; font-size: 11px; color: #7c8072; }
.eyebrow { letter-spacing: 2px; color: #596348; }
.intro { padding: 62px 0 43px; max-width: 480px; }
.small { font-size: 12px; color: #8a8c73; }
h1 { font-size: clamp(29px, 5vw, 42px); letter-spacing: -1.5px; line-height: 1.3; font-weight: 500; margin: 14px 0; }
p { font-size: 13px; line-height: 1.85; color: #787b6e; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
article { min-height: 228px; padding: 22px; background: #eeeee4; border: 1px solid #e4e4d8; border-radius: 5px; }
article:nth-child(2) { background: #e8ece2; }
article:nth-child(3) { background: #f0e9df; }
.number { font-size: 10px; color: #858777; letter-spacing: 1px; }
h2 { font-size: 17px; line-height: 1.5; font-weight: 500; margin-top: 23px; }
.tag { display: inline-block; font-size: 10px; padding: 5px 8px; margin-top: 7px; border: 1px solid #d9ddcd; border-radius: 20px; color: #7b8269; }
footer { margin-top: 45px; border-top: 1px solid #e1e2d7; padding-top: 18px; }
a { color: inherit; text-decoration: none; }
@media (max-width: 600px) { .page { padding: 24px; } .intro { padding-top: 44px; } .cards { grid-template-columns: 1fr; } article { min-height: 180px; } }`;
const docBefore = `# 给新成员的一封介绍

我们致力于通过创新、高效、全面的协作体验，赋能每一个团队成员充分发挥价值，打造极致的工作体验。

本工具具有项目管理、任务沟通、资料整理等丰富的功能，能够满足不同场景下的各种需求。欢迎使用并探索。`;
const docAfter = `# 从一件小事开始

欢迎加入。第一天不必记住所有入口，先挑一件你今天想完成的小事。

你可以在对话里说明目标，把手头的材料放进来。需要你决定时，我们会停下来问清楚；完成后，结果和过程都在原来的位置。

比如，先把一份会议笔记整理成要点，或者把想法写成可以讨论的初稿。如果暂时没有合适的任务，也可以先看一个示例。

用起来后，告诉我们哪里不清楚、哪里打断了你。具体的一件小事，比一句“整体还不错”更能帮助我们改进。`;

export const WORKSPACE_SCENES = [
  ["review", "代码审阅"],
  ["web", "网页预览"],
  ["document", "文稿对照"],
  ["run", "运行输出"],
];
export const WORKSPACE_DATA = {
  review: {
    label: "代码审阅",
    title: "项目卡片交互审阅",
    summary:
      "这组改动有 3 处需要确认，主要影响键盘操作与禁用状态。我把问题和对应位置整理在下面，先讨论清楚，再决定怎么调整。",
    files: [
      {
        id: "card",
        path: "src/ProjectCard.tsx",
        language: "tsx",
        before: cardBefore,
        after: cardAfter,
      },
      {
        id: "style",
        path: "src/project.css",
        language: "css",
        before: cssBefore,
        after: cssAfter,
      },
      {
        id: "test",
        path: "src/ProjectCard.test.tsx",
        language: "tsx",
        before: tests,
        after: tests,
      },
    ],
    findings: [
      {
        id: "keyboard",
        severity: "高",
        title: "卡片不再能用键盘打开",
        detail:
          "按钮被换成了没有键盘事件和焦点入口的 div，Tab 与 Enter 的操作路径会中断。",
        fileId: "card",
        line: 5,
        prompt:
          "请先讨论这条审阅反馈：ProjectCard.tsx 第 5 行把 button 改为 div 后，如何保留 Tab 聚焦与 Enter 打开？确认方案后再修改。",
      },
      {
        id: "disabled",
        severity: "中",
        title: "禁用状态仍会触发点击",
        detail:
          "aria-disabled 只提供语义，onClick 仍直接执行 onOpen。需要明确禁用时是否阻止打开。",
        fileId: "card",
        line: 7,
        prompt:
          "请检查 ProjectCard.tsx 第 7 行：disabled 时 onClick 仍调用 onOpen。先说明预期行为与调整方案。",
      },
      {
        id: "focus",
        severity: "中",
        title: "焦点提示被移除了",
        detail:
          "focus-visible 设置 outline:none，键盘用户会失去当前位置反馈；测试也只覆盖鼠标点击。",
        fileId: "style",
        line: 13,
        prompt:
          "请针对 project.css 第 13 行移除焦点轮廓的问题，提出清晰且符合现有风格的焦点方案，并说明需要增加的键盘测试。",
      },
    ],
    activities: [
      "阅读 3 个示例文件",
      "检查交互语义和键盘路径",
      "整理 3 条审阅反馈",
    ],
  },
  web: {
    label: "网页预览",
    title: "周末小计划页面",
    summary:
      "整理成了三段周末安排，保留了适合手机阅读的版本。页面用了偏暖的底色和轻量卡片，重点放在阅读节奏上。",
    files: [
      {
        id: "html",
        path: "weekend/index.html",
        language: "html",
        before: html,
        after: html,
      },
      {
        id: "css",
        path: "weekend/style.css",
        language: "css",
        before: css,
        after: css,
      },
    ],
    findings: [],
    activities: ["整理页面结构", "设置适应不同宽度的排版", "准备本地预览"],
  },
  document: {
    label: "文稿对照",
    title: "新成员介绍文稿",
    summary:
      "把抽象介绍改成了具体的第一步，也保留了邀请反馈的意图。原稿与修改稿都留着，方便你比较哪些表达更合适。",
    files: [
      {
        id: "intro",
        path: "docs/welcome.md",
        language: "markdown",
        before: docBefore,
        after: docAfter,
      },
    ],
    findings: [],
    activities: ["阅读原稿", "调整开头与信息顺序", "补充具体例子和下一步"],
  },
  run: {
    label: "运行输出",
    title: "项目卡片测试结果",
    summary:
      "这份输出里，4 项检查有 2 项失败，分别涉及键盘打开与禁用状态。下面把失败原因和相关代码联系起来，先看清楚问题再处理。",
    files: [
      {
        id: "card",
        path: "src/ProjectCard.tsx",
        language: "tsx",
        before: cardBefore,
        after: cardAfter,
      },
      {
        id: "test",
        path: "src/ProjectCard.test.tsx",
        language: "tsx",
        before: runTests,
        after: runTests,
      },
    ],
    findings: [],
    activities: ["展示示例测试输出", "保留失败断言", "等待下一步处理"],
    tests: [
      {
        id: "name",
        name: "显示项目名称",
        status: "passed",
        duration: "18 ms",
        detail: "名称与传入值一致。",
        fileId: "test",
        line: 3,
      },
      {
        id: "mouse",
        name: "鼠标点击打开项目",
        status: "passed",
        duration: "24 ms",
        detail: "onOpen 被调用 1 次。",
        fileId: "test",
        line: 9,
      },
      {
        id: "keyboard",
        name: "Tab 聚焦后用 Enter 打开",
        status: "failed",
        duration: "63 ms",
        detail:
          "Expected onOpen to be called once\nReceived: 0 calls\n\n卡片没有进入键盘焦点顺序。",
        fileId: "card",
        line: 5,
      },
      {
        id: "disabled",
        name: "禁用时不触发打开",
        status: "failed",
        duration: "21 ms",
        detail:
          "Expected onOpen not to be called\nReceived: 1 call\n\naria-disabled 没有阻止点击处理函数。",
        fileId: "card",
        line: 7,
      },
    ],
    logs: [
      {
        time: "14:31:02",
        level: "info",
        text: "$ npm run test -- ProjectCard（本地输出样例）",
      },
      {
        time: "14:31:02",
        level: "info",
        text: "4 tests · ProjectCard.test.tsx",
      },
      {
        time: "14:31:03",
        level: "error",
        text: "FAIL Tab 聚焦后用 Enter 打开 · Expected 1 call, received 0",
      },
      {
        time: "14:31:03",
        level: "error",
        text: "FAIL 禁用时不触发打开 · Expected 0 calls, received 1",
      },
      {
        time: "14:31:03",
        level: "info",
        text: "2 passed · 2 failed · exit code 1",
      },
    ],
  },
};
export const WORKSPACE_TASKS = WORKSPACE_SCENES.map(([kind, label]) => ({
  id: `workspace-${kind}`,
  workspaceKind: kind,
  workspaceExample: true,
  workspacePanel: {
    open: true,
    tab: { review: "diff", web: "preview", document: "compare", run: "tests" }[
      kind
    ],
    file: WORKSPACE_DATA[kind].files[0].id,
  },
  title: WORKSPACE_DATA[kind].title,
  prompt: {
    review: "帮我审阅这组项目卡片改动。先指出问题和位置，不要直接修改。",
    web: "看看这个周末小计划页面，帮我确认桌面和窄屏下的阅读体验。",
    document: "把这份新成员介绍改得具体、自然一些，保留原稿，方便我比较。",
    run: "帮我读一下这份测试输出，把失败项和相关代码联系起来。",
  }[kind],
  project: {
    review: "产品想法",
    run: "产品想法",
    web: "旅行与生活",
    document: "阅读与写作",
  }[kind],
  group: {
    review: "产品想法",
    run: "产品想法",
    web: "旅行与生活",
    document: "阅读与写作",
  }[kind],
  agent: "Codex",
  model: "6 Astra",
  effort: "High",
  source: "沿用已有设置",
  status: "done",
  draft: "",
  queue: [],
  time: "本地示例",
  label,
}));
