import { invoke } from "@tauri-apps/api/core";

export type ProjectTrust = "saved" | "approve" | "ignore";

export interface ProjectResource {
  kind:
    | "settings"
    | "skill"
    | "extension"
    | "prompt"
    | "theme"
    | "system"
    | "append-system"
    | "agent-skill";
  entries: number;
  sources: string[];
}

export interface ProjectReadiness {
  projectPath: string;
  contextFiles: string[];
  protectedResources: ProjectResource[];
}

export type ExtensionDialogRequest = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
};

export type ExtensionUiRequest =
  | ExtensionDialogRequest
  | {
      type: "extension_ui_request";
      id: string;
      method:
        "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
      message?: string;
      notifyType?: "info" | "warning" | "error";
      statusKey?: string;
      statusText?: string;
      widgetKey?: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
      title?: string;
      text?: string;
    };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseExtensionUiRequest(
  value: unknown,
): ExtensionUiRequest | null {
  const request = objectValue(value);
  if (
    request?.type !== "extension_ui_request" ||
    typeof request.id !== "string" ||
    typeof request.method !== "string"
  ) {
    return null;
  }
  const methods = [
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ] as const;
  if (!methods.includes(request.method as (typeof methods)[number]))
    return null;
  if (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  ) {
    if (typeof request.title !== "string") return null;
    if (
      request.method === "select" &&
      (!Array.isArray(request.options) ||
        !request.options.every((option) => typeof option === "string"))
    ) {
      return null;
    }
  }
  return request as ExtensionUiRequest;
}

export function getProjectReadiness(
  projectPath: string,
): Promise<ProjectReadiness> {
  return invoke("runtime_project_readiness", { projectPath });
}
