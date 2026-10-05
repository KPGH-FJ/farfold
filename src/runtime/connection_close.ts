/** App-owned close reasons, never inferred from Agent error text. */
export type ConnectionCloseReason =
  | "idle"
  | "user"
  | "shutdown"
  | "configuration"
  | "startup_failed"
  | "unexpected";

export function connectionCloseReason(value: unknown): ConnectionCloseReason {
  switch (value) {
    case "idle":
    case "user":
    case "shutdown":
    case "configuration":
    case "startup_failed":
      return value;
    default:
      return "unexpected";
  }
}
