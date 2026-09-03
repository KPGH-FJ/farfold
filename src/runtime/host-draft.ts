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
  const bodyRef = useRef(body);
  const editRevision = useRef(0);
  const loadGeneration = useRef(0);
  const hydratedSession = useRef<string | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  bodyRef.current = body;

  const updateBody = (value: string) => {
    editRevision.current += 1;
    bodyRef.current = value;
    setBody(value);
  };

  useEffect(() => {
    const generation = (loadGeneration.current += 1);
    const previousSession = hydratedSession.current;
    if (previousSession) {
      void persistHostSessionDraft(previousSession, bodyRef.current).catch(
        errorHandler.current,
      );
    }
    hydratedSession.current = null;
    bodyRef.current = "";
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
        bodyRef.current = restored;
        hydratedSession.current = farfoldSessionId;
        setBody(restored);
      })
      .catch((error) => {
        if (!cancelled && generation === loadGeneration.current) {
          errorHandler.current(error);
        }
      });
    return () => {
      cancelled = true;
      if (hydratedSession.current === farfoldSessionId) {
        void persistHostSessionDraft(farfoldSessionId, bodyRef.current).catch(
          errorHandler.current,
        );
        hydratedSession.current = null;
      }
    };
  }, [farfoldSessionId]);

  useEffect(() => {
    if (!farfoldSessionId || hydratedSession.current !== farfoldSessionId) {
      return;
    }
    const timer = window.setTimeout(() => {
      void persistHostSessionDraft(farfoldSessionId, body).catch(
        errorHandler.current,
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [body, farfoldSessionId]);

  return [body, updateBody];
}
