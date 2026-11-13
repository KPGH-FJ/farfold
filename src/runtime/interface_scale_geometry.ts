/** Actual main-webview page zoom, updated only after the native acknowledgement.
 * Native child bounds read pageZoom themselves; this is for AppKit drag points. */
let applied = 1;
export function getAppliedInterfaceScale(): number {
  return applied;
}
export function setAppliedInterfaceScale(value: number): void {
  applied = value;
}
