import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  PROJECT_FILES,
  projectFilesError,
  projectFilesResult,
  type ProjectFilesResult,
} from "../runtime/project_files";

type Request = {
  id: string;
  key: string;
  cwd: string;
  retired: boolean;
  settled: boolean;
  responded: boolean;
  cancelRequested: boolean;
};
export type ProjectFileScan = {
  key: string;
  cwd: string;
  requestId: string;
  phase: "loading" | "cancelling" | "ready" | "error" | "pending";
  cancelRequested?: boolean;
  paths: string[];
  result?: ProjectFilesResult;
  error?: string;
};

export function useProjectFiles(
  key: string,
  cwd: string | null | undefined,
  active: boolean,
) {
  const [state, setState] = useState<ProjectFileScan | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<Request | null>(null);
  const owner = useRef({ key, cwd, active });
  owner.current = { key, cwd, active };
  const owns = (r: Request) =>
    request.current === r &&
    !r.retired &&
    owner.current.active &&
    owner.current.key === r.key &&
    owner.current.cwd === r.cwd;
  const cancelRequest = (r: Request) => {
    if (r.settled || r.cancelRequested) return;
    r.cancelRequested = true;
    void invoke("project_files_cancel", { requestId: r.id }).catch(() => {
      if (owns(r) && !r.settled) {
        r.cancelRequested = false;
        setState(
          (previous) =>
            previous && {
              ...previous,
              phase: r.responded ? "pending" : "loading",
              cancelRequested: false,
              error: PROJECT_FILES.cancelFailed,
            },
        );
      }
    });
  };
  useEffect(() => {
    if (!active || !cwd) return;
    const r: Request = {
      id: crypto.randomUUID(),
      key,
      cwd,
      retired: false,
      settled: false,
      responded: false,
      cancelRequested: false,
    };
    request.current = r;
    setState({ key, cwd, requestId: r.id, phase: "loading", paths: [] });
    void invoke<unknown>("project_files", { cwd, requestId: r.id })
      .then((raw) => {
        const result = projectFilesResult(raw, r.id, cwd);
        r.settled = true;
        r.responded = true;
        if (owns(r))
          setState({
            key,
            cwd,
            requestId: r.id,
            phase: "ready",
            paths: result.files,
            result,
          });
      })
      .catch((error: unknown) => {
        const message = projectFilesError(error);
        r.settled = message !== PROJECT_FILES.pending;
        r.responded = true;
        if (owns(r))
          setState({
            key,
            cwd,
            requestId: r.id,
            phase: r.settled ? "error" : "pending",
            cancelRequested: r.cancelRequested,
            paths: [],
            error:
              !r.settled && r.cancelRequested
                ? PROJECT_FILES.pendingCancel
                : message,
          });
      });
    return () => {
      r.retired = true;
      cancelRequest(r);
    };
  }, [key, cwd, active, attempt]);
  const current =
    active && state?.key === key && state.cwd === cwd ? state : null;
  const visibleRequest =
    current?.requestId === request.current?.id ? request.current : null;
  return {
    state: current,
    cancel: () => {
      const r = visibleRequest;
      if (!r || !owns(r) || r.settled || r.cancelRequested) return;
      setState(
        (previous) =>
          previous && {
            ...previous,
            phase: r.responded ? "pending" : "cancelling",
            cancelRequested: true,
            error: r.responded ? PROJECT_FILES.pendingCancel : undefined,
          },
      );
      cancelRequest(r);
    },
    retry: () => {
      const r = visibleRequest;
      if (r && owns(r) && r.responded) setAttempt((value) => value + 1);
    },
  };
}
