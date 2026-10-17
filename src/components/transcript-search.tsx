import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type RefCallback,
} from "react";
import {
  SearchExpansion,
  registerSearchExpansion,
  keepSearchAncestors,
} from "../runtime/transcript_search";
import { MessageMediaVisibility } from "./message-media-visibility";

export const TranscriptSearchContext = createContext(false);
export function useTranscriptSearchActive() {
  return useContext(TranscriptSearchContext);
}

export function useSearchExpansion(initial = false) {
  const active = useTranscriptSearchActive();
  const [, update] = useState(0);
  const model = useRef<SearchExpansion | null>(null);
  if (!model.current)
    model.current = new SearchExpansion(initial, () =>
      update((value) => value + 1),
    );
  const fold = model.current;
  const node = useRef<HTMLElement | null>(null);
  const choose = (open: boolean) => {
    fold.choose(open);
    if (open && node.current) keepSearchAncestors(node.current);
  };
  const ref = useRef<RefCallback<HTMLElement> | null>(null);
  if (!ref.current) {
    let unregister: (() => void) | undefined;
    ref.current = (element) => {
      unregister?.();
      node.current = element;
      unregister = element ? registerSearchExpansion(element, fold) : undefined;
    };
  }
  return {
    open: fold.open,
    userOpen: fold.userOpen,
    materialized: active || fold.open,
    ref: ref.current,
    toggle: () => choose(!fold.open),
    choose,
    onToggle: (event: { currentTarget: HTMLDetailsElement }) => {
      // Prop-driven toggle events do not count as a new user preference.
      if (event.currentTarget.open !== fold.open)
        choose(event.currentTarget.open);
    },
  };
}

export function SearchDisclosure({
  children,
  ...props
}: Omit<ComponentProps<"details">, "open" | "onToggle" | "ref">) {
  const fold = useSearchExpansion();
  return (
    <details
      {...props}
      ref={fold.ref}
      open={fold.open}
      onToggle={fold.onToggle}
    >
      <MessageMediaVisibility visible={fold.open}>
        {children}
      </MessageMediaVisibility>
    </details>
  );
}
