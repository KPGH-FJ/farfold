import { expect, it } from "vitest";
import {
  currentAccountRegistration,
  parseAccountRegistration,
} from "./account_registration";
const record = {
  methodId: "method",
  url: "https://account.example.com/",
  page: "external" as const,
};
const link = { label: "Account", kind: "account" as const, url: record.url };
it("only restores known method-specific official destinations and resets stale links to selection", () => {
  expect(currentAccountRegistration(record, "method", [link])).toEqual(record);
  for (const links of [
    [],
    [{ ...link, url: "https://other.example.com/" }],
    [{ ...link, kind: "documentation" as const }],
  ]) {
    expect(currentAccountRegistration(record, "method", links)).toEqual({
      methodId: "method",
      url: "",
      page: "choose",
    });
  }
  expect(currentAccountRegistration(record, "different", [link])?.page).toBe(
    "choose",
  );
});
it("drops unknown fields and refuses unsafe or success-shaped registration state", () => {
  expect(
    parseAccountRegistration(
      { ...record, authenticated: true, key: "not-a-key" },
      "method",
    ),
  ).toEqual(record);
  expect(
    parseAccountRegistration(
      { ...record, url: "https://user:pass@example.com/" },
      "method",
    ),
  ).toBeUndefined();
  expect(
    parseAccountRegistration({ ...record, page: "success" }, "method"),
  ).toBeUndefined();
});
