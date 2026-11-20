import { expect, it } from "vitest";
import { canUseService } from "./service_capability";

const capability = {
  apiTypes: ["messages", "responses"],
  endpointRules: [
    {
      apiType: "messages",
      requiredPathSuffix: "/v1",
      allowedExactEndpoints: ["https://api.anthropic.com"],
    },
  ],
};

it.each([
  "https://api.anthropic.com",
  "https://api.anthropic.com/",
  " HTTPS://API.ANTHROPIC.COM:443/ ",
  "https://a.test/v1",
  "https://a.test/prefix/v1/",
  " https://a.test/prefix/v1/// ",
])(
  "accepts the normalized official address or a matching path (%s)",
  (endpoint) => {
    expect(canUseService(capability, { apiType: "messages", endpoint })).toBe(
      true,
    );
  },
);

it.each([
  "https://a.test",
  "https://v1",
  "https://a.test/not-v1",
  "https://a.test/v1/extra",
  "https://a.test/v1/messages",
  "https://a.test/v1/..",
  "https://a.test/v1?",
  "https://a.test/?path=/v1",
  "https://a.test/v1#",
  "https://a.test/v1#fragment",
  "https://user:token@a.test/v1",
  "https://token@a.test/v1",
  "http://a.test/v1",
  "https://api.anthropic.com.a.test",
  "https://api.anthropic.com:8443",
  "https://api.anthropic.com/extra",
  "a.test/v1",
])(
  "rejects an unsafe address or an address outside the rule (%s)",
  (endpoint) => {
    expect(canUseService(capability, { apiType: "messages", endpoint })).toBe(
      false,
    );
  },
);

it("retains format-only eligibility when the route publishes no endpoint rule", () => {
  const endpoint = "https://a.test";
  expect(canUseService(capability, { apiType: "responses", endpoint })).toBe(
    true,
  );
  expect(
    canUseService(
      { apiTypes: ["messages"] },
      { apiType: "messages", endpoint },
    ),
  ).toBe(true);
  expect(
    canUseService(capability, { apiType: "chat-completions", endpoint }),
  ).toBe(false);
  expect(canUseService(null, { apiType: "messages", endpoint })).toBe(false);
});
