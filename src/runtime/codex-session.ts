export interface CodexNativeTurn {
  id: string;
  items: Record<string, unknown>[];
  status: string;
  [field: string]: unknown;
}

export interface CodexNativeSession {
  thread: {
    id: string;
    sessionId: string;
    cwd: string;
    cliVersion: string;
    createdAt: number;
    updatedAt: number;
    modelProvider: string;
    ephemeral: boolean;
    preview: string;
    source: unknown;
    status: { type: string };
    turns: CodexNativeTurn[];
    name: string | null;
  };
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
  cwd: string;
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandbox: unknown;
}
