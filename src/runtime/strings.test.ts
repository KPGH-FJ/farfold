import { BROWSER_WORKSPACE_STRINGS } from "./browser_workspace_strings";
import { describe, expect, it } from "vitest";
import { COMPOSER_CONTROLS } from "./composer_strings";
import { DRAFT_STRINGS } from "./draft_storage";
import { AUTH_ACTIVITY_STRINGS } from "./auth_strings";
import { LIBRARY } from "./library_strings";
import { ACCESS_STRINGS } from "./access_strings";
import { IMPORT_STRINGS } from "./import_strings";
import { STRINGS } from "./strings";
import { FILE_DELIVERY_STRINGS } from "./file_delivery_strings";
import { WORKSPACE_STRINGS } from "./workspace_strings";
import { PREPARATION_STRINGS } from "./preparation_strings";
import { PREPARATION_ACTION_STRINGS } from "./preparation_action_strings";
import { INSTALLATION_INPUT_STRINGS } from "./installation_strings";
import { API_EDITOR_STRINGS } from "./api_editor_strings";
import { SETUP_STORAGE_STRINGS } from "./setup_storage";
import { AGENT_SETUP_STRINGS } from "./agent_setup_strings";
import { THREAD_VIEW_STRINGS } from "./thread_view_strings";
import { CUSTOM_AGENT } from "./custom_agent_strings";
import { SETUP_PRESENTATION } from "./setup_presentation_strings";
import { SETTINGS_PRESENTATION } from "./settings_presentation_strings";
import { NEW_CONVERSATION_PICKER_STRINGS } from "./new_conversation_picker_strings";
import { METHOD_API_KEY_STRINGS } from "./method_api_key_strings";
import { CONNECTION_STRINGS } from "./r5_auth_strings";
import { R5_SERVICE_STRINGS } from "./r5_service_strings";
import { R5_PROGRAM_STRINGS } from "./r5_program_strings";
import { R5_SETUP_STRINGS } from "./r5_setup_strings";

// PRODUCT.md §5 禁用词：不得出现在任何用户可见字符串中。
const FORBIDDEN =
  /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i;

function collectStrings(value: unknown, path: string[]): [string, string][] {
  if (typeof value === "string") return [[path.join("."), value]];
  if (typeof value === "function") {
    const fn = value as (arg: unknown) => string;
    // Cover both number- and string-taking formatters.
    return [
      [path.join("."), fn(2)],
      [path.join("."), fn("1.2.3")],
      [path.join("."), fn("/tmp/example")],
    ];
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => collectStrings(child, [...path, key]),
    );
  }
  return [];
}

describe("strings", () => {
  const leaves = collectStrings(
    {
      STRINGS,
      FILE_DELIVERY_STRINGS,
      BROWSER_WORKSPACE_STRINGS,
      COMPOSER_CONTROLS,
      DRAFT_STRINGS,
      AUTH_ACTIVITY_STRINGS,
      WORKSPACE_STRINGS,
      LIBRARY,
      ACCESS_STRINGS,
      IMPORT_STRINGS,
      PREPARATION_STRINGS,
      PREPARATION_ACTION_STRINGS,
      INSTALLATION_INPUT_STRINGS,
      API_EDITOR_STRINGS,
      SETUP_STORAGE_STRINGS,
      AGENT_SETUP_STRINGS,
      THREAD_VIEW_STRINGS,
      CUSTOM_AGENT,
      SETUP_PRESENTATION,
      SETTINGS_PRESENTATION,
      NEW_CONVERSATION_PICKER_STRINGS,
      METHOD_API_KEY_STRINGS,
      CONNECTION_STRINGS,
      R5_SERVICE_STRINGS,
      R5_PROGRAM_STRINGS,
      R5_SETUP_STRINGS,
    },
    [],
  );

  it("contains real copy", () => {
    expect(leaves.length).toBeGreaterThan(50);
    for (const [path, text] of leaves) {
      expect(text.trim().length, path).toBeGreaterThan(0);
    }
  });

  it("contains no forbidden vocabulary", () => {
    const offenders = leaves.filter(([, text]) => FORBIDDEN.test(text));
    expect(offenders).toEqual([]);
  });
});
