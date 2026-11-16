import { describe, it, expect } from "vitest";
import {
  authenticationRequired,
  captureProgramAuthentication,
  currentAuthenticationRequired,
  invalidateAuthentication,
  observeAuthentication,
  programAuthenticationChanged,
  subscribeAuthenticationChanges,
} from "./authentication";
import { completion } from "./completion";
import { uiError } from "./ui_error";
import { STRINGS } from "./strings";
describe("conditional authentication", () => {
  it("invalidates account actions across views without treating normal protocol observations as changes", () => {
    const changed: string[] = [];
    const unsubscribe = subscribeAuthenticationChanges((agentId) =>
      changed.push(agentId),
    );
    observeAuthentication("account", "/test", "AUTH_REQUIRED");
    observeAuthentication("account", "/test");
    expect(changed).toEqual([]);
    invalidateAuthentication("account");
    expect(changed).toEqual(["account"]);
    unsubscribe();
    invalidateAuthentication("other");
    expect(changed).toEqual(["account"]);
  });
  it("does not confuse login availability with a requirement", () => {
    expect(authenticationRequired(new Set(), "agent", "/project")).toBe(false);
    const required = new Set(["agent\n/one\n"]);
    expect(authenticationRequired(required, "agent", "/one")).toBe(true);
    expect(authenticationRequired(required, "agent", "/two")).toBe(false);
    expect(authenticationRequired(required, "other", "/one")).toBe(false);
  });
  it("keeps an API login error separate from the Agent's existing account", () => {
    const required = new Set(["agent\n/project\napi-a"]);
    expect(authenticationRequired(required, "agent", "/project")).toBe(false);
    expect(authenticationRequired(required, "agent", null)).toBe(false);
    expect(authenticationRequired(required, "agent", "/project", "api-a")).toBe(
      true,
    );
    expect(authenticationRequired(required, "agent", "/project", "api-b")).toBe(
      false,
    );
  });
  it("recognizes only the protocol category, without parsing reply text", () => {
    expect(uiError("AUTH_REQUIRED", "fallback")).toBe(
      STRINGS.access.authRequired,
    );
    expect(uiError("Please log in AUTH_REQUIRED", "fallback")).toBe("fallback");
    expect(completion({ error: "AUTH_REQUIRED" })).toEqual({
      status: "failed",
      error: STRINGS.access.authRequired,
    });
    observeAuthentication("test", "/test", new Error("timeout"));
  });

  it("retires only the replaced program's evidence and ignores late results from it", () => {
    const agent = "replaced-program";
    const old = captureProgramAuthentication(agent);
    const other = captureProgramAuthentication("other-program");
    old.observe("/before", "AUTH_REQUIRED");
    old.observe("/before", "AUTH_REQUIRED", "api-a", "request");
    other.observe("/before", "AUTH_REQUIRED");

    programAuthenticationChanged(agent);
    expect(old.current()).toBe(false);
    expect(other.current()).toBe(true);
    expect(currentAuthenticationRequired(agent, null)).toBe(false);
    expect(currentAuthenticationRequired(agent, null, "api-a")).toBe(false);
    expect(currentAuthenticationRequired("other-program", "/before")).toBe(
      true,
    );

    old.observe("/before", "AUTH_REQUIRED");
    expect(currentAuthenticationRequired(agent, "/before")).toBe(false);
    const fresh = captureProgramAuthentication(agent);
    fresh.observe("/before", "AUTH_REQUIRED", undefined, "request");
    old.observe("/before", undefined, undefined, "request");
    expect(currentAuthenticationRequired(agent, "/before")).toBe(true);
    fresh.observe("/before", undefined, undefined, "request");
    expect(currentAuthenticationRequired(agent, "/before")).toBe(false);
  });
});
