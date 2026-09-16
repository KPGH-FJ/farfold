import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageContent } from "./MessageContent";

describe("message result links", () => {
  it("offers explicit file actions instead of navigating the app webview", () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: "[report.md](/Users/qa/Project%20Files/report.md:1)",
        ...{
          session: { farfoldSessionId: "host-a", nativeSessionId: "native-a" },
        },
      }),
    );
    expect(html).toContain("打开");
    expect(html).toContain("定位");
    expect(html).toContain("<button");
    expect(html).not.toContain('href="/Users/');
  });

  it("does not offer an unbound local file action", () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, { text: "[result](./report.md)" }),
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
    expect(html).toContain("result");
  });
});
