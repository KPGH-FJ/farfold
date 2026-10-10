import { expect, it } from "vitest";
import cases from "./fixtures/mcp-http-url-cases.json";
import { mcpAddInputError, freezeMcpAddInput } from "./mcp_add_types";
const input = (url: string) => ({
  transport: "streamableHttp" as const,
  name: "literal.a",
  url,
});
it.each(cases.cases)("shared literal $id", ({ url, accepted }) => {
  expect(mcpAddInputError(input(url))).toBe(accepted ? null : "invalidUrl");
  if (accepted) expect(freezeMcpAddInput(input(url))).toEqual(input(url));
});
const prefix = "https://endpoint.test/";
const generated = new Map([
  ["byte-limit-exact", prefix + "a".repeat(4096 - prefix.length)],
  ["byte-limit-over", prefix + "a".repeat(4097 - prefix.length)],
  ["unpaired-surrogate", prefix + "\ud800"],
  [
    "bounded-many-zero-port",
    "https://endpoint.test:" + "0".repeat(4000) + "443/mcp",
  ],
]);
it.each(cases.generatedCases)("shared generated $id", ({ id, accepted }) => {
  const value = generated.get(id);
  expect(typeof value).toBe("string");
  expect(mcpAddInputError(input(value!))).toBe(accepted ? null : "invalidUrl");
  if (accepted) expect(freezeMcpAddInput(input(value!))).toEqual(input(value!));
});
it("rejects mixed transport, credential/config fields and unknown keys without echo", () => {
  for (const fields of [
    { args: [] },
    { executablePath: "/a" },
    { headers: {} },
    { env: {} },
    { bearerToken: "SYNTHETIC" },
    { private: true },
  ]) {
    expect(mcpAddInputError({ ...input(prefix), ...fields })).toBe(
      "invalidRequest",
    );
  }
  expect(
    mcpAddInputError({ name: "valid", transport: "http", url: prefix }),
  ).toBe("invalidRequest");
});
