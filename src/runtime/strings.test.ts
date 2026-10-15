import { ATTACHMENT_SEARCH_STRINGS } from "./attachment_search_strings";
import { REMEMBERED_BROWSER_STRINGS } from "./browser_remembered_strings";
import { HISTORY_SEARCH_STRINGS } from "./history_search_strings";
import { EXTENSION_INVENTORY_STRINGS } from "./extension_inventory_strings";
import { WORKTREE_PREPARATION_STRINGS } from "./worktree_preparation_strings";
import { ASYNC_TASKS } from "./async_task_strings";
import { VISUAL_AREA_STRINGS } from "./visual_area_strings";
import { WORKTREE_STRINGS } from "./worktree_strings";
import { LOADED_SEARCH_STRINGS } from "./loaded_search_strings";
import { REPORTED_ARTIFACT_STRINGS } from "./reported_artifact_strings";
import { REDESIGN } from "./redesign_strings";
import { DOCUMENT_STRINGS, DOCUMENT_WARNINGS } from "./document_strings";
import { PPTX_STRINGS, PPTX_WARNINGS } from "./pptx_strings";
import { INQUIRY } from "./elicitation_strings";
import { AGENT_REDESIGN } from "./agent_redesign_strings";
import { SETTINGS_REDESIGN } from "./settings_redesign_strings";
import { CONVERSATION_REDESIGN } from "./conversation_redesign_strings";
import { BROWSER_WORKSPACE_STRINGS } from "./browser_workspace_strings";
import { describe, expect, it } from "vitest";
import { COMPOSER_CONTROLS } from "./composer_strings";
import { DRAFT_STRINGS } from "./draft_storage";
import { IMAGE_INPUT_STRINGS } from "./draft_images";
import { IMAGE_BYTES_STRINGS } from "./image_bytes";
import { AUTH_ACTIVITY_STRINGS } from "./auth_strings";
import { LIBRARY } from "./library_strings";
import { ACCESS_STRINGS } from "./access_strings";
import { IMPORT_STRINGS } from "./import_strings";
import { STRINGS } from "./strings";
import { FILE_DELIVERY_STRINGS } from "./file_delivery_strings";
import { FILE_OPEN_STRINGS } from "./file_open_strings";
import { SOURCE_TEXT_SELECTION_STRINGS } from "./source_text_selection_strings";
import { WORKSPACE_STRINGS } from "./workspace_strings";
import { PREPARATION_STRINGS } from "./preparation_strings";
import { PREPARATION_ACTION_STRINGS } from "./preparation_action_strings";
import { INSTALLATION_INPUT_STRINGS } from "./installation_strings";
import { API_EDITOR_STRINGS } from "./api_editor_strings";
import { SETUP_STORAGE_STRINGS } from "./setup_storage";
import { AGENT_SETUP_STRINGS } from "./agent_setup_strings";
import { THREAD_VIEW_STRINGS } from "./thread_view_strings";
import { CUSTOM_AGENT } from "./custom_agent_strings";
import { AGENT_DETAIL_STRINGS } from "./agent_detail_strings";
import { SETUP_PRESENTATION } from "./setup_presentation_strings";
import { SETTINGS_PRESENTATION } from "./settings_presentation_strings";
import { NEW_CONVERSATION_PICKER_STRINGS } from "./new_conversation_picker_strings";
import { METHOD_API_KEY_STRINGS } from "./method_api_key_strings";
import { CONNECTION_STRINGS } from "./r5_auth_strings";
import { R5_SERVICE_STRINGS } from "./r5_service_strings";
import { R5_PROGRAM_STRINGS } from "./r5_program_strings";
import { R5_SETUP_STRINGS } from "./r5_setup_strings";
import { ACCOUNT_GUIDE_STRINGS } from "./account_guide_strings";
import { ARCHIVE_STRINGS } from "./auto_archive";
import { ARTIFACT_OUTPUT } from "./artifact_output_strings";
import { ATTACHMENT_REVIEW } from "./attachment_review_strings";
import { BROWSER_SHARING_STRINGS } from "./browser_sharing_strings";
import { CREDENTIAL_IMPACT_STRINGS } from "./credential_impact_strings";
import { NOTIFICATION_STRINGS } from "./desktop_notifications";
import { DIAGNOSTIC_STRINGS } from "./diagnostics";
import { ERROR_STRINGS } from "./error_strings";
import { EXIT_IMPACT } from "./exit_impact";
import { FEEDBACK_STRINGS } from "./feedback_strings";
import { MESSAGE_ATTACHMENTS } from "./message_attachment_strings";
import { SENDING_STRINGS } from "./sending_strings";
import { UPDATE_IMPACT } from "./update_impact";
import { CONNECTION_ACCOUNT_STRINGS } from "./connection_account_strings";
import { SIDEBAR_STRINGS } from "./sidebar_strings";
import { WORKBOOK_STRINGS, WORKBOOK_WARNINGS } from "./workbook_strings";
import { EXPORT_STRINGS } from "./export_strings";
import { ARCHIVE_STRINGS as CONVERSATION_ARCHIVE_STRINGS } from "./conversation_archive_strings";

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
      REMEMBERED_BROWSER_STRINGS,
      HISTORY_SEARCH_STRINGS,
      ATTACHMENT_SEARCH_STRINGS,
      ASYNC_TASKS,
      WORKTREE_STRINGS,
      WORKTREE_PREPARATION_STRINGS,
      EXTENSION_INVENTORY_STRINGS,
      REPORTED_ARTIFACT_STRINGS,
      DOCUMENT_STRINGS,
      PPTX_STRINGS,
      PPTX_WARNINGS,
      VISUAL_AREA_STRINGS,
      LOADED_SEARCH_STRINGS,
      DOCUMENT_WARNINGS,
      INQUIRY,
      WORKBOOK_STRINGS,
      WORKBOOK_WARNINGS,
      REDESIGN,
      AGENT_REDESIGN,
      SETTINGS_REDESIGN,
      CONVERSATION_REDESIGN,

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
      AGENT_DETAIL_STRINGS,
      SETUP_PRESENTATION,
      SETTINGS_PRESENTATION,
      NEW_CONVERSATION_PICKER_STRINGS,
      METHOD_API_KEY_STRINGS,
      CONNECTION_STRINGS,
      R5_SERVICE_STRINGS,
      R5_PROGRAM_STRINGS,
      R5_SETUP_STRINGS,
      ACCOUNT_GUIDE_STRINGS,
      ARCHIVE_STRINGS,
      ARTIFACT_OUTPUT,
      ATTACHMENT_REVIEW,
      BROWSER_SHARING_STRINGS,
      CREDENTIAL_IMPACT_STRINGS,
      NOTIFICATION_STRINGS,
      DIAGNOSTIC_STRINGS,
      ERROR_STRINGS,
      EXIT_IMPACT,
      FEEDBACK_STRINGS,
      FILE_OPEN_STRINGS,
      SOURCE_TEXT_SELECTION_STRINGS,
      IMAGE_INPUT_STRINGS,
      IMAGE_BYTES_STRINGS,
      MESSAGE_ATTACHMENTS,
      SENDING_STRINGS,
      UPDATE_IMPACT,
      CONNECTION_ACCOUNT_STRINGS,
      SIDEBAR_STRINGS,
      EXPORT_STRINGS,
      CONVERSATION_ARCHIVE_STRINGS,
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
