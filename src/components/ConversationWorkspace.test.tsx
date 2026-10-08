import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { freshThreadState, applyUpdate } from "../runtime/sessions";
import { composerDrafts } from "../runtime/drafts";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";

it("keeps pending approvals outside collapsed tool steps and keeps the content header independent", () => {
  const thread = freshThreadState("a:/notes:test", "a", "/notes", "test");
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Read notes",
    status: "in_progress",
    kind: "read",
  });
  thread.pendingPermissions.push({
    requestId: "approval",
    status: "pending",
    error: null,
    toolCallId: "t1",
    title: "Allow reading notes",
    kind: "read",
    locations: [],
    decision: null,
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
  });
  thread.artifactPaneOpen = true;
  const html = renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
      header={<header>Conversation heading</header>}
    />,
  );
  const folded = html.slice(
    html.indexOf('<details class="workspace-steps"'),
    html.indexOf("</details>"),
  );
  // The step row shows the user-language summary; the raw title stays inside
  // the collapsed technical details, which are not rendered while folded.
  expect(folded).toContain("查看了文件");
  expect(folded).not.toContain("Allow reading notes");
  expect(html.indexOf("Allow reading notes")).toBeGreaterThan(
    html.indexOf("</details>"),
  );
  expect(html).toContain("1 项需要你回应");
  expect(html).toContain(
    '<div class="thread-main"><header>Conversation heading</header>',
  );
  expect(html).toContain('aria-label="调整内容宽度"');
});

it("permits writing before setup while sending stays unavailable, including an unsupported retained image", () => {
  composerDrafts.update("new", () => ({
    text: "Keep this",
    attachments: [
      { id: "image", kind: "image", name: "picture.png", data: "abc" },
    ],
  }));
  const html = renderToStaticMarkup(
    <Composer
      thread={null}
      imageEnabled={false}
      onGoSettings={() => {}}
      disabled
      editableWhenDisabled
    />,
  );
  const textarea = html.slice(
    html.indexOf("<textarea"),
    html.indexOf("</textarea>"),
  );
  expect(textarea).toContain("Keep this");
  expect(textarea).not.toContain("disabled");
  expect(html).toContain("当前 Agent 不支持图片");
  expect(html).toMatch(/aria-label="发送[^"\n]*" disabled=""/);
  composerDrafts.clear("new");
});

it("keeps the conversation popover controls mounted but disabled while its page is hidden", () => {
  const thread = freshThreadState("a:/notes:hidden", "a", "/notes", "hidden");
  const html = renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active={false}
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
  // Controls stay mounted for a stable layout; inactivity only disables them.
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="模型与来源"/);
});
