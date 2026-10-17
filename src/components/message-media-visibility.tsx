import { createContext, useContext, type ReactNode } from "react";

const MessageMediaVisibilityContext = createContext(true);

/** Retained transcript text may be hidden by several nested disclosures.
 * Opening a child must never override a hidden ancestor's media boundary. */
export function MessageMediaVisibility({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const parentVisible = useContext(MessageMediaVisibilityContext);
  return (
    <MessageMediaVisibilityContext.Provider value={parentVisible && visible}>
      {children}
    </MessageMediaVisibilityContext.Provider>
  );
}

export function useMessageMediaVisibility() {
  return useContext(MessageMediaVisibilityContext);
}
