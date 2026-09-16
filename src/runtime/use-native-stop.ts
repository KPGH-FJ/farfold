import { useRef, useState } from "react";
import { NativeStopRequest } from "./native-stop-request";

export function useNativeStop(
  scope: string | null,
  working: boolean,
  onError: (message: string) => void,
): {
  stopping: boolean;
  requestStop: (send: () => Promise<unknown>) => Promise<void>;
} {
  const [request] = useState(() => new NativeStopRequest());
  const [, update] = useState(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  request.reconcile(scope, working);
  return {
    stopping: request.stopping,
    requestStop: (send) =>
      request.request(
        send,
        () => update((revision) => revision + 1),
        (message) => errorHandler.current(message),
      ),
  };
}
