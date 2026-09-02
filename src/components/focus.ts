const INTERACTIVE_FOCUS_TARGET =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export interface FocusCandidate {
  isConnected: boolean;
  matches(selector: string): boolean;
}

export function canRestoreFocus(
  candidate: FocusCandidate | null,
): candidate is FocusCandidate {
  return Boolean(
    candidate?.isConnected && candidate.matches(INTERACTIVE_FOCUS_TARGET),
  );
}
