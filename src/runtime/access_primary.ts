import { useEffect, useRef } from "react";

export interface AgentAccessPrimary {
  id: string;
  label: string;
  disabled: boolean;
  run: () => void;
}

/** The footer displays one action while its owning form keeps the live input. */
export function useAccessPrimary(
  action: AgentAccessPrimary | null,
  onChange?: (action: AgentAccessPrimary | null) => void,
) {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!onChange) return;
    const expected = latest.current;
    onChange(
      expected
        ? {
            ...expected,
            run: () => {
              const current = latest.current;
              if (current?.id === expected.id && !current.disabled)
                current.run();
            },
          }
        : null,
    );
    return () => onChange(null);
  }, [onChange, action?.id, action?.label, action?.disabled]);
}
