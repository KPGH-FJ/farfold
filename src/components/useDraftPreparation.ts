import { useEffect, useRef } from "react";
import { DraftLocationOwner } from "../runtime/draft_location_owner";
import {
  createPreparationDraftTarget,
  type PreparationDraftTarget,
} from "../runtime/draft_preparation";

/** Must be opened after Use; never borrows the retired location-choice token. */
export function useDraftPreparation(options: {
  context: string;
  active: boolean;
  cwd: string | null;
  allowed: () => boolean;
  onBegin: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const owner = useRef(new DraftLocationOwner());
  const target = useRef<PreparationDraftTarget | null>(null);
  const observed = useRef({ context: options.context, active: options.active });
  if (
    observed.current.context !== options.context ||
    observed.current.active !== options.active
  ) {
    target.current?.retire();
    target.current = null;
    observed.current = { context: options.context, active: options.active };
  }
  owner.current.observe(options.context, options.active);
  useEffect(
    () => () => {
      owner.current.retire();
      target.current?.retire();
    },
    [],
  );
  return () => {
    const current = latest.current;
    if (!current.cwd || !current.allowed()) return null;
    current.onBegin();
    if (latest.current !== current || !current.allowed()) return null;
    target.current?.retire();
    const token = owner.current.begin();
    const next = createPreparationDraftTarget(
      current.cwd,
      () =>
        owner.current.owns(token) &&
        latest.current.cwd === current.cwd &&
        latest.current.allowed(),
    );
    target.current = next;
    return next;
  };
}
