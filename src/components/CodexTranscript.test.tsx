import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CodexTranscript } from "./CodexTranscript";
it("one transcript presents typed ACP content and labels unavailable native details", () => {
  const html = renderToStaticMarkup(
    <CodexTranscript
      session={null}
      acp={{
        incomplete: true,
        notice: "limited",
        turns: [
          {
            nativeTurnId: "native",
            hostTurnId: null,
            source: "history",
            status: "completed",
            items: [
              { type: "agentMessage", id: "message", text: "历史正文" },
              {
                type: "reasoning",
                id: "reasoning",
                summary: ["推理摘要"],
                content: ["推理内容"],
              },
              { type: "commandExecution", id: "command", status: "completed" },
            ],
          },
        ],
      }}
    />,
  );
  expect(html.match(/class="message-list"/g)).toHaveLength(1);
  expect(html).toContain("历史正文");
  expect(html).toContain("推理摘要");
  expect(html).toContain("命令全文、输出或差异未提供");
  expect(html).toContain("Host Turn 身份未恢复");
  expect(html).toContain("不能视为完整历史");
  expect(html).not.toContain("&quot;type&quot;");
});
