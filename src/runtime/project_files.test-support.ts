import type { ProjectFilesResult } from "./project_files";

export function projectFilesFixture(
  requestId: string,
  files = ["note.txt"],
  overrides: Partial<ProjectFilesResult> = {},
): ProjectFilesResult {
  return {
    requestId,
    files,
    truncated: false,
    partial: false,
    cancelled: false,
    limits: {
      files: 2000,
      depth: 10,
      entries: 20000,
      entriesPerDirectory: 4096,
      directories: 2000,
      pathBytes: 1048576,
      timeMs: 5000,
    },
    counts: {
      entries: files.length,
      directories: 1,
      skippedDirectories: 0,
      unreadableDirectories: 0,
      unreadableEntries: 0,
      unsupportedNames: 0,
    },
    limitReasons: [],
    excludedDirectoryNames: [".git", "node_modules"],
    ...overrides,
  };
}
