import { invoke } from "@tauri-apps/api/core";

export interface ProjectFileSession {
  farfoldSessionId: string;
  nativeSessionId: string;
}

export function revealProjectFile(
  session: ProjectFileSession,
  path: string,
): Promise<void> {
  return invoke("host_reveal_project_file", {
    input: {
      farfoldSessionId: session.farfoldSessionId,
      nativeSessionId: session.nativeSessionId,
      path,
    },
  });
}

export function openProjectFile(
  session: ProjectFileSession,
  path: string,
): Promise<void> {
  return invoke("host_open_project_file", {
    input: {
      farfoldSessionId: session.farfoldSessionId,
      nativeSessionId: session.nativeSessionId,
      path,
    },
  });
}

export function projectFileReferences(
  farfoldSessionId: string,
  nativeSessionId: string,
  paths: string[],
): Promise<string[]> {
  return invoke("host_project_file_references", {
    input: { farfoldSessionId, nativeSessionId, paths },
  });
}

export function appendProjectReferences(
  draft: string,
  paths: string[],
): string {
  return `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}项目文件路径（按需读取）：\n${paths.map((path) => JSON.stringify(path)).join("\n")}\n`;
}
