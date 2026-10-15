import { useEffect, useRef } from "react";
import { DraftLocationOwner } from "../runtime/draft_location_owner";

/** Carries only ownership of the editor's actual completed preparation. */
export function usePreparedComposerOwner(context: string, active: boolean) {
  const owner = useRef(new DraftLocationOwner());
  const latest = useRef({ context, active });
  latest.current = { context, active };
  owner.current.observe(context, active);
  const opened = useRef<{ key: string; context: string } | null>(null);
  const claim = useRef<{
    key: string;
    token: object | null;
    current: () => boolean;
  } | null>(null);
  useEffect(() => () => owner.current.retire(), []);
  return {
    open(key: string) {
      if (latest.current.context !== context || !latest.current.active) return;
      owner.current.retire();
      opened.current = { key, context };
      claim.current = null;
    },
    current(key: string | null): (() => boolean) | null {
      if (
        !key ||
        !active ||
        opened.current?.key !== key ||
        opened.current.context !== context
      )
        return null;
      if (
        claim.current?.key !== key ||
        !owner.current.owns(claim.current.token)
      ) {
        const token = owner.current.begin();
        claim.current = {
          key,
          token,
          current: () =>
            owner.current.owns(token) && latest.current.context === context,
        };
      }
      return claim.current.current;
    },
  };
}
