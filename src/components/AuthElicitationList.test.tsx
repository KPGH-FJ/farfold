import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthActivity } from "../runtime/auth_activity";
import { AuthElicitationList } from "./AuthElicitationList";

it.each(["cancel", "endConnection"] as const)(
  "keeps questions disabled after %s cannot confirm its outcome",
  async (method) => {
    const activity = new AuthActivity();
    activity.begin(
      { agentId: "fixture", cwd: "/controlled" },
      {
        kind: "authentication",
        methodId: "fixture",
        title: "Fixture",
        completion: "exit_code",
      },
      "attempt",
    );
    let fail!: (error: unknown) => void;
    const running = activity.protocol({
      run: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      cancel: async () => {
        throw new Error("controlled cancellation failure");
      },
      end: async () => {
        throw new Error("controlled end failure");
      },
      reconnect: async () => {},
    });
    activity.inquiryEvent("attempt", {
      kind: "elicitation",
      requestId: "q",
      mode: "form",
      message: "Review",
      schema: { type: "object", properties: { value: { type: "string" } } },
    });
    await activity[method]();
    try {
      expect(activity.getSnapshot()?.phase).toBe("unknown");
      const html = renderToStaticMarkup(
        <AuthElicitationList
          activity={activity}
          job={activity.getSnapshot()!}
          agentName="Fixture"
        />,
      );
      expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
      activity.editInquiry("q", "value", "must not change");
      expect(activity.getSnapshot()?.inquiries?.[0].values).toEqual({});
    } finally {
      fail(new Error("controlled parent end"));
      await running;
    }
  },
);
