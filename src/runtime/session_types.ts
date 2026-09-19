/**
 * Normalized thread view-model types (extracted from `sessions.ts` to keep
 * it under the file-size cap; `sessions.ts` re-exports this module).
 */
import type { ArtifactView, ElicitationView, TerminalTail } from "./artifacts";

/** Content blocks accepted by `session_prompt`. */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; name: string; uri: string; mimeType?: string };

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
  startedAt: number;
  endedAt?: number;
  rawInput?: unknown;
  rawOutput?: unknown;
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
      /** fileDiff + terminal artifacts recorded during this round. */
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
  pendingPermission: PendingPermission | null;
  /** Pending `elicitation/create` form awaiting the user's values. */
  pendingElicitation: ElicitationView | null;
  /** fs/terminal artifacts recorded for this session (live events plus
   *  `session_artifacts` hydration). */
  artifacts: ArtifactView[];
  /** terminalId → rolling output tail for `terminal/*` tool content. */
  terminalTails: Record<string, TerminalTail>;
  /** Artifact drawer open state. */
  artifactPaneOpen: boolean;
  /** `session_artifacts` fetched at least once (memory-only backend list
   *  replaced wholesale on each fetch). */
  artifactsHydrated: boolean;
  /** items/artifacts length when the current round started, for the
   *  settled row's "本轮产物" count. */
  roundItemBase: number;
  roundArtifactBase: number;
  configOptions: ConfigOptionView[];
  usage: { used: number; size: number } | null;
  availableCommands: AvailableCommand[];
  currentModeId: string | null;
  connectionLost: boolean;
  /** First prompt sent — the agent/model choice is fixed from then on. */
  prompted: boolean;
  resumed: boolean;
  openError: string | null;
  /** Open failed on the resume path — render as 无法恢复, not a blank
   *  session (PRODUCT.md §7). */
  unrecoverable: boolean;
  /** Latest agent-reported title needs to reach the index row once. */
  metaDirty: boolean;
}
