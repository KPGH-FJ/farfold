/**
 * Normalized thread view-model types (extracted from `sessions.ts` to keep
 * it under the file-size cap; `sessions.ts` re-exports this module).
 */
import type { ElicitationView } from "./artifacts";

/** Content blocks accepted by `session_prompt`. */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; name: string; uri: string; mimeType?: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; text: string };
    };

export interface Attachment {
  name: string;
  uri?: string;
  mimeType?: string;
}

export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface ToolLocation {
  path: string;
  line?: number;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "link"; name: string; uri: string }
  | { type: "raw"; value: unknown };

export interface ToolCallView {
  toolCallId: string;
  title: string;
  name?: string;
  /** `read|edit|delete|move|search|execute|think|fetch|switch_mode|other`. */
  kind: string;
  /** `pending|in_progress|completed|failed`. */
  status: string;
  locations: ToolLocation[];
  content: ToolContent[];
  /** Local observation time; 0 means the start was not observed (e.g. replay). */
  startedAt: number;
  endedAt?: number;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Read-only output streamed by the Agent's own terminal. */
  terminalOutput?: string;
}

export type ThreadItem =
  | {
      kind: "user";
      id: string;
      text: string;
      attachments: Attachment[];
      streaming: boolean;
      time: number;
    }
  | {
      kind: "agent";
      id: string;
      text: string;
      streaming: boolean;
      time: number;
    }
  | {
      kind: "thought";
      id: string;
      text: string;
      streaming: boolean;
      time: number;
    }
  | { kind: "tool"; id: string; call: ToolCallView }
  | { kind: "plan"; id: string; entries: PlanEntry[]; time: number }
  | { kind: "raw"; id: string; update: unknown; label?: string; time: number }
  | {
      /** Permission decision record left in the transcript after the card
       *  resolves (the card itself disappears). */
      kind: "decision";
      id: string;
      label: string;
      allow: boolean;
      time: number;
    }
  | {
      kind: "settled";
      id: string;
      status: "done" | "stopped" | "failed" | "unknown";
      stopReason?: string;
      error?: string;
      /** Count of file diffs seen in this round's tool calls. */
      diffCount: number;
      /** diff + command cards produced during this round. */
      artifactCount: number;
      time: number;
    };

export interface ConfigChoice {
  value: string;
  name: string;
  group?: string;
}

export interface ConfigOptionView {
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** `select` | `boolean` | other future kinds. */
  type: string;
  currentValue: unknown;
  options: ConfigChoice[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** `allow_once` | `allow_always` | `reject_once` | `reject_always`. */
  kind: string;
}

export interface PendingPermission {
  submitting?: boolean;
  error?: string | null;
  requestId: string;
  toolCallId: string | null;
  title: string;
  kind: string;
  locations: ToolLocation[];
  options: PermissionOption[];
  /** Held decision during the undo window (response not yet sent). */
  decision: {
    optionId: string;
    label: string;
    allow: boolean;
    /** `allow_always` only — undo reverts the "remember" before it lands. */
    undoable: boolean;
  } | null;
}

export interface AvailableCommand {
  name: string;
  description?: string;
}

export interface ThreadState {
  /** `<agentId>:<cwd>:<nativeSessionId>` — also the index row id. */
  key: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  title: string | null;
  items: ThreadItem[];
  running: boolean;
  queued: PromptBlock[][];
  pendingPermissions: PendingPermission[];
  identity: "draft" | "established";
  reconnecting: boolean;
  submitting: boolean;
  configuring: boolean;
  configError: string | null;
  workEnabled: boolean;
  queuePaused: import("./queue").QueuePause;
  uncertainPrompt: PromptBlock[] | null;
  stopping: boolean;
  /** Cancel sent but completion was not confirmed; request may still execute. */
  stopUnconfirmed: boolean;
  /** Pending `elicitation/create` form awaiting the user's values. */
  pendingElicitation: ElicitationView | null;
  /** Artifact drawer open state. */
  artifactPaneOpen: boolean;
  /** items length when the current round started, for the settled row's
   *  "本轮产物" count. */
  roundItemBase: number;
  configOptions: ConfigOptionView[];
  usage: { used: number; size: number } | null;
  availableCommands: AvailableCommand[];
  currentModeId: string | null;
  /** Agent exposes `modes` outside `configOptions` — the synthetic `mode`
   *  option routes to `session/set_mode` instead of `set_config_option`. */
  modesSeparate: boolean;
  /** Resumed session's reported model differs from the one recorded at
   *  creation — shown read-only; never re-sent (restored sessions are
   *  read-only per contract). */
  /** Derived from the backend config check, including reasoning and unknown values. */
  modelDrift: boolean;
  configCheck: import("./config_check").ConfigCheck | null;
  recordedModel?: string;
  connectionLost: boolean;
  /** First prompt sent — the agent/model choice is fixed from then on. */
  resumed: boolean;
  openError: string | null;
  /** Open failed on the resume path — render as 无法恢复, not a blank
   *  session (PRODUCT.md §7). */
  unrecoverable: boolean;
  /** Latest agent-reported title needs to reach the index row once. */
  metaDirty: boolean;
}
