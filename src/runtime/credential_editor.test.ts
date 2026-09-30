import { describe, expect, it } from "vitest";
import {
  credentialDraft,
  credentialDraftForSave,
  credentialDraftChanged,
  credentialEndpointIssue,
  credentialSaveIssue,
  modelCandidates,
} from "./credential_editor";
import { API_EDITOR_STRINGS as S } from "./api_editor_strings";
import type { Credential } from "./credentials";

const saved = {
  id: "service-one",
  label: "My service",
  provider: "Custom",
  endpoint: "https://example.com/v1",
  apiType: "responses",
  models: ["model-one", "model-two"],
  revision: "r1",
  complete: true,
  deleting: false,
  grants: [],
} as Credential;

describe("API editor discard protection", () => {
  it("detects the name-only new draft that Escape previously discarded", () => {
    const original = credentialDraft(null);
    expect(credentialDraftChanged(original, original)).toBe(false);
    expect(
      credentialDraftChanged({ ...original, label: "Unsaved" }, original),
    ).toBe(true);
    expect(credentialDraftChanged({ ...original, label: "" }, original)).toBe(
      false,
    );
  });
  it("protects changed secrets, removed models, and an unsubmitted model input", () => {
    const original = credentialDraft(saved);
    expect(
      credentialDraftChanged({ ...original, key: "test-only-value" }, original),
    ).toBe(true);
    expect(
      credentialDraftChanged({ ...original, models: ["model-one"] }, original),
    ).toBe(true);
    expect(credentialDraftChanged(original, original, "model-three")).toBe(
      true,
    );
    expect(original.key).toBe("");
  });
  it("does not mutate the saved record when editing its model list", () => {
    const original = credentialDraft(saved);
    const editing = credentialDraft(saved);
    editing.models.pop();
    expect(saved.models).toEqual(["model-one", "model-two"]);
    expect(credentialDraftChanged(editing, original)).toBe(true);
  });
});

describe("fetched model candidates", () => {
  it("deduplicates, excludes existing models, and filters only candidates without changing the draft", () => {
    const draft = credentialDraft(saved);
    const results = ["model-one", "FAST-New", "other", "FAST-New"];
    expect(modelCandidates(results, draft.models, " fast ")).toEqual([
      "FAST-New",
    ]);
    expect(draft.models).toEqual(["model-one", "model-two"]);
    expect(results).toHaveLength(4);
  });
  it("returns no candidates when all matching models have already been added", () => {
    expect(
      modelCandidates(["model-one", "model-two"], saved.models, "model"),
    ).toEqual([]);
  });
});

describe("saving a model list", () => {
  it("blocks unadded text even with existing models, without changing either input", () => {
    const draft = credentialDraft(saved);
    const pending = " model-three ";
    expect(credentialDraftForSave(draft, pending)).toBeNull();
    expect(credentialDraftForSave(draft, "model-one")).toBeNull();
    expect(draft.models).toEqual(["model-one", "model-two"]);
    expect(pending).toBe(" model-three ");
    expect(credentialDraftForSave(draft, "  ")).toBe(draft);
  });
});

describe("API editor field feedback", () => {
  it.each([
    ["", S.endpointRequired],
    ["models.example.com/v1", S.endpointRequired],
    ["http://models.example.com/v1", S.endpointInvalid],
    ["https://user:secret@models.example.com/v1", S.endpointInvalid],
    ["https://models.example.com/v1?key=secret", S.endpointInvalid],
    ["https://models.example.com/v1?", S.endpointInvalid],
    ["https://models.example.com/v1#", S.endpointInvalid],
    ["https://models.example.com/v1\n", S.endpointInvalid],
    ["https://models.example.com/" + "模".repeat(100), S.endpointInvalid],
    ["https://models.example.com/v1/chat/completions/", S.endpointPath],
    ["https://models.example.com/v1/responses", S.endpointPath],
    ["https://models.example.com/v1/messages", S.endpointPath],
    ["https://models.example.com/v1/models", S.endpointPath],
    [" https://models.example.com/custom/v1/ ", null],
  ])("explains the endpoint boundary for %s", (endpoint, expected) => {
    expect(credentialEndpointIssue(endpoint)).toBe(expected);
  });

  it("updates missing save requirements as fields are completed without requiring a test", () => {
    const draft = credentialDraft(null);
    const options = {
      retainingKey: false,
      preservingLegacy: false,
      pendingModel: "",
    };
    expect(credentialSaveIssue(draft, options)).toBe(S.labelRequired);
    draft.label = "Own service";
    expect(credentialSaveIssue(draft, options)).toBe(S.endpointRequired);
    draft.endpoint = "https://models.example.com/v1";
    draft.apiType = "unknown";
    expect(credentialSaveIssue(draft, options)).toBe(S.formatRequired);
    draft.apiType = "responses";
    expect(credentialSaveIssue(draft, options)).toBe(S.keyRequired);
    draft.key = "test-only-key";
    expect(credentialSaveIssue(draft, options)).toBe(S.modelsRequired);
    draft.models = ["own-model"];
    expect(credentialSaveIssue(draft, options)).toBeNull();
    expect(
      credentialSaveIssue(draft, { ...options, pendingModel: "other-model" }),
    ).toBe(S.pendingModel);
  });

  it("retains legacy description edits without allowing invalid replacement secrets", () => {
    const draft = credentialDraft({
      ...saved,
      complete: false,
      endpoint: "",
      apiType: "",
      models: [],
    });
    const options = {
      retainingKey: true,
      preservingLegacy: true,
      pendingModel: "",
    };
    expect(credentialSaveIssue(draft, options)).toBeNull();
    draft.key = " \n ";
    expect(credentialSaveIssue(draft, options)).toBe(S.keyInvalid);
    draft.key = "test-only-key";
    expect(credentialSaveIssue(draft, options)).toBeNull();
    expect(
      credentialSaveIssue(draft, { ...options, preservingLegacy: false }),
    ).toBe(S.endpointRequired);
  });
});
