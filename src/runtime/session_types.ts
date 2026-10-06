/**
 * Normalized thread view-model types (extracted from `sessions.ts` to keep
 * it under the file-size cap; `sessions.ts` re-exports this module).
 */
import type { CommandEntry } from "./commands";

/** Content blocks accepted by `session_prompt`. */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "resource_link"; name: string; uri: string; mimeType?: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; text: string };
    };

export interface Attachment {
  name: string;
  uri?: string;
  mimeType?: string;
  kind?: "image" | "audio" | "resource" | "resource_link";
  /** Declared message or tool content; memory only, never a local transcript. */
  data?: string;
  text?: string;
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
  | { type: "attachment"; attachment: Attachment }
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
      attachments?: Attachment[];
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
  | {
      kind: "raw";
      id: string;
      update: unknown;
      label?: string;
      /** In-memory marker set only by the ordinary notification route. */
      streamNeutral?: true;
      time: number;
    }
  | { kind: "notice"; id: string; message: string; time: number }
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
      /** References into this in-memory projection, never a persisted history. */
      artifactToolItemIds?: string[];
      /** Whether this live round received readable Agent content, never thoughts. */
      replyReceived?: boolean;
      time: number;
    };

export interface ConfigChoice {
  description?: string;
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

export interface PendingRequest {
  requestId: string;
  status: "pending" | "submitting" | "uncertain";
  error: string | null;
}

export interface PendingElicitation extends PendingRequest {
  message: string;
  schema: Record<string, unknown> | null;
  toolCallId: string | null;
  values: Record<string, unknown>;
}

export interface PendingPermission extends PendingRequest {
  toolCallId: string | null;
  /** Exact data for this request, never borrowed from a mutable live tool. */
  toolCallSnapshot?: Record<string, unknown> | null;
  /** Original request params, including opaque extensions; memory only. */
  requestSnapshot?: unknown;
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

export type AvailableCommand = CommandEntry;

export interface ThreadState {
  /** `<agentId>:<cwd>:<nativeSessionId>` — also the index row id. */
  key: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  service?: import("./credentials").ServiceIdentity;
  serviceContext?: string;
  /** Live process only, not saved in the conversation index. */
  connectionId?: string;
  sourceError?: boolean;
  draftGroup?: string;
  title: string | null;
  items: ThreadItem[];
  running: boolean;
  /** Live IDs reported by the connection, separate from prompt/replayed status. */
  activeToolCallIds: string[];
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
  pendingElicitations: PendingElicitation[];
  /** Artifact drawer open state. */
  artifactPaneOpen: boolean;
  /** Explicit round navigation is separate from the session-wide choice. */
  artifactPaneTarget: { roundId: string; selected: string | null } | null;
  artifactPaneSelection: string | null;
  /** items length when the current round started, for the settled row's
   *  "本轮产物" count. */
  roundItemBase: number;
  configOptions: ConfigOptionView[];
  permissionConfigId?: string;
  permissionState: "ready" | "required" | "changing" | "unknown";
  usage: { used: number; size: number } | null;
  availableCommands: AvailableCommand[];
  currentModeId: string | null;
  /** Agent exposes `modes` outside `configOptions` — the synthetic `mode`
   *  option routes to `session/set_mode` instead of `set_config_option`. */
  modesSeparate: boolean;
  /** Restored choices differ from the latest confirmed configuration. */
  /** Derived from the backend config check, including reasoning and unknown values. */
  modelDrift: boolean;
  configCheck: import("./config_check").ConfigCheck | null;
  recordedModel?: string;
  connectionLost: boolean;
  connectionCloseReason?: import("./connection_close").ConnectionCloseReason;
  /** Unconfirmed execution/admission, independent of the user-owned retry copy.
   * An idle disconnect alone has no unknown result. */
  connectionOutcomeUnknown: boolean;
  /** The Agent restored this existing session, rather than creating a draft. */
  resumed: boolean;
  openError: string | null;
  /** App-owned replay admission failure; never inferred from remote text. */
  historyUnavailable: {
    reason: "empty" | "incomplete";
    sourceKnown: boolean;
  } | null;
  /** Open failed on the resume path — render as 无法恢复, not a blank
   *  session (PRODUCT.md §7). */
  unrecoverable: boolean;
  /** Latest agent-reported title needs to reach the index row once. */
  metaDirty: boolean;
  /** In-memory current webpage decision; never serialized as Agent history. */
  browserReadRequestId?: string | null;
}

export function hasPendingRequests(
  state: Pick<ThreadState, "pendingPermissions" | "pendingElicitations"> &
    Pick<ThreadState, "browserReadRequestId">,
): boolean {
  return (
    state.pendingPermissions.length > 0 ||
    state.pendingElicitations.length > 0 ||
    Boolean(state.browserReadRequestId)
  );
}

export function hasActiveTools(
  state: Pick<ThreadState, "activeToolCallIds" | "connectionLost">,
): boolean {
  return !state.connectionLost && state.activeToolCallIds.length > 0;
}

/** Rendering only: never rewrite the Agent's reported tool status. */
export function toolActivityState(
  state: Pick<ThreadState, "activeToolCallIds" | "connectionLost">,
  call: ToolCallView,
): "active" | "finished" | "unknown" {
  if (call.status === "completed" || call.status === "failed")
    return "finished";
  return !state.connectionLost &&
    state.activeToolCallIds.includes(call.toolCallId)
    ? "active"
    : "unknown";
}
