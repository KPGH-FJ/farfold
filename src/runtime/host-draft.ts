import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

export interface HostSessionDraft {
  farfoldSessionId: string;
  body: string;
  updatedAt: number;
}

export function getHostSessionDraft(
  farfoldSessionId: string,
): Promise<HostSessionDraft | null> {
  return invoke("session_draft_get", { farfoldSessionId });
}

export function setHostSessionDraft(
  farfoldSessionId: string,
  body: string,
): Promise<HostSessionDraft> {
  return invoke("session_draft_set", {
    input: { farfoldSessionId, body },
  });
}

export function clearHostSessionDraft(farfoldSessionId: string): Promise<void> {
  return invoke("session_draft_clear", { farfoldSessionId }).then(
    () => undefined,
  );
}

function persistHostSessionDraft(
  farfoldSessionId: string,
  body: string,
): Promise<unknown> {
  return body
    ? setHostSessionDraft(farfoldSessionId, body)
    : clearHostSessionDraft(farfoldSessionId);
}

export function useHostSessionDraft(
  farfoldSessionId: string | null,
  onError: (error: unknown) => void,
): [string, (value: string) => void] {
  const [body, setBody] = useState("");
  const editRevision = useRef(0);
  const loadGeneration = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;

  const updateBody = (value: string) => {
    editRevision.current += 1;
    setBody(value);
    // Dispatch from the edit itself: a timer or effect can be discarded by quit.
    // These synchronous Host commands commit in the WebView command order.
    if (farfoldSessionId) {
      void persistHostSessionDraft(farfoldSessionId, value).catch(
        errorHandler.current,
      );
    }
  };

  useEffect(() => {
    const generation = (loadGeneration.current += 1);
    setBody("");
    if (!farfoldSessionId) return;

    const revisionAtStart = editRevision.current;
    let cancelled = false;
    void getHostSessionDraft(farfoldSessionId)
      .then((draft) => {
        if (
          cancelled ||
          generation !== loadGeneration.current ||
          editRevision.current !== revisionAtStart
        ) {
          return;
        }
        const restored = draft?.body ?? "";
        setBody(restored);
      })
      .catch((error) => {
        if (!cancelled && generation === loadGeneration.current) {
          errorHandler.current(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [farfoldSessionId]);

  return [body, updateBody];
}
