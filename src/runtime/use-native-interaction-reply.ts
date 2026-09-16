import { useState } from "react";
import { NativeInteractionReply } from "./native-interaction-reply";

export function useNativeInteractionReply(scope: string | null) {
  const [reply] = useState(() => new NativeInteractionReply());
  const [, update] = useState(0);
  reply.reconcile(scope);
  return {
    busy: reply.busy,
    error: reply.error,
    respond: (
      send: () => Promise<unknown>,
      accepted: () => void,
      failed: (message: string) => void,
    ) =>
      reply.reply(send, accepted, failed, () => update((value) => value + 1)),
  };
}
