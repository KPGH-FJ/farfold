import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { FileCopyJob } from "../runtime/file_copy_jobs";
const h = vi.hoisted(() => ({
  jobs: [] as FileCopyJob[],
  check: vi.fn(),
  cancel: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("../runtime/file_copy_jobs", () => ({
  useFileCopyJobs: () => h.jobs,
  fileCopyJobs: { check: h.check, cancel: h.cancel, dismiss: h.dismiss },
}));
import { FileCopyJobsStatus } from "./FileCopyJobsStatus";
import { FILE_COPY_STRINGS as S } from "../runtime/file_copy_strings";
const file = {
  root: "/w",
  path: "a",
  resolvedPath: "/w/a",
  name: "a",
  size: 6,
  version: "1",
  sha256: "h",
};
const base: FileCopyJob = {
  id: 1,
  file,
  destination: "/out/a",
  phase: "known",
  checking: false,
  status: {
    operationId: "op",
    file,
    destination: "/out/a",
    state: "copying",
    settled: false,
    bytesCopied: 0,
    total: 6,
  },
};
function elements(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(tree, (c) => {
    if (isValidElement<Record<string, unknown>>(c))
      result.push(c, ...elements(c.props.children as ReactNode));
  });
  return result;
}
function button(label: string) {
  return elements(FileCopyJobsStatus({})).find(
    (n) => n.type === "button" && n.props.children === label,
  );
}
beforeEach(() => {
  h.jobs = [];
  h.check.mockClear();
  h.cancel.mockClear();
  h.dismiss.mockClear();
});
it("keeps query and cancellation reachable while ordinary application input is locked", () => {
  h.jobs = [{ ...base, checking: true }];
  expect(button(S.check)?.props.disabled).toBe(true);
  const cancel = button(S.cancel)!;
  expect(cancel.props.disabled).not.toBe(true);
  (cancel.props.onClick as () => void)();
  expect(h.cancel).toHaveBeenCalledWith(1);
  expect(button(S.close)).toBeUndefined();
});
it("cannot dismiss a locally unknown write with no proof of completed IO", () => {
  h.jobs = [{ ...base, phase: "uncertain" }];
  expect(renderToStaticMarkup(<FileCopyJobsStatus />)).toContain(S.uncertain);
  expect(button(S.check)).toBeDefined();
  expect(button(S.close)).toBeUndefined();
  expect(button(S.closeUnknown)).toBeUndefined();
});
it("an authoritative settled unknown has an explicit acknowledgement rather than success wording", () => {
  h.jobs = [
    {
      ...base,
      phase: "uncertain",
      status: { ...base.status!, state: "unknown", settled: true },
    },
  ];
  const html = renderToStaticMarkup(<FileCopyJobsStatus />);
  expect(html).toContain(S.uncertain);
  expect(html).not.toContain(S.states.completed);
  expect(button(S.cancel)).toBeUndefined();
  (button(S.closeUnknown)!.props.onClick as () => void)();
  expect(h.dismiss).toHaveBeenCalledWith(1, true);
});
it("closed preparation can be dismissed without an operation ID", () => {
  h.jobs = [{ ...base, phase: "notStarted", status: undefined }];
  expect(button(S.check)).toBeUndefined();
  expect(button(S.cancel)).toBeUndefined();
  (button(S.close)!.props.onClick as () => void)();
  expect(h.dismiss).toHaveBeenCalledWith(1);
});
it("filters by exact verified source while a global view remains available", () => {
  h.jobs = [base];
  expect(
    renderToStaticMarkup(
      <FileCopyJobsStatus file={{ ...file, version: "2" }} />,
    ),
  ).toBe("");
  expect(renderToStaticMarkup(<FileCopyJobsStatus />)).toContain("/out/a");
});
it("exact-ID absence remains an explicitly unknown result and has no restart or cancel action", () => {
  h.jobs = [{ ...base, phase: "uncertain", absence: true }];
  const html = renderToStaticMarkup(<FileCopyJobsStatus />);
  expect(html).toContain(S.uncertain);
  expect(html).not.toContain(S.states.completed);
  expect(button(S.check)).toBeUndefined();
  expect(button(S.cancel)).toBeUndefined();
  (button(S.closeUnknown)!.props.onClick as () => void)();
  expect(h.dismiss).toHaveBeenCalledWith(1, true);
});

it("offers destination actions only for a complete published destination receipt, keeping legacy success visible", () => {
  const original = { ...file, sha256: "a".repeat(64) };
  const completed: FileCopyJob = {
    ...base,
    file: original,
    status: {
      ...base.status!,
      file: original,
      state: "completed",
      settled: true,
      bytesCopied: 6,
      receipt: {
        kind: "fileCopy",
        destination: base.destination,
        size: 6,
        sha256: original.sha256,
        sourceVersion: original.version,
        destinationFile: {
          ...original,
          root: "/out",
          path: base.destination,
          resolvedPath: base.destination,
          version: "copy-version",
        },
      },
    },
  };
  h.jobs = [completed];
  const html = renderToStaticMarkup(<FileCopyJobsStatus />);
  expect(html).toContain(S.openCopy);
  expect(html).toContain(S.revealCopy);
  expect(html).toContain(S.states.completed);
  const inactive = renderToStaticMarkup(<FileCopyJobsStatus active={false} />);
  expect(inactive.match(/<button[^>]*>打开副本<\/button>/)?.[0]).toContain(
    'disabled=""',
  );
  for (const next of [
    { ...completed, absence: true as const },
    { ...completed, phase: "uncertain" as const },
    { ...completed, status: { ...completed.status!, settled: false } },
    {
      ...completed,
      status: {
        ...completed.status!,
        state: "failed" as const,
        receipt: undefined,
      },
    },
    {
      ...completed,
      status: {
        ...completed.status!,
        receipt: { ...completed.status!.receipt!, destinationFile: undefined },
      },
    },
  ]) {
    h.jobs = [next];
    const result = renderToStaticMarkup(<FileCopyJobsStatus />);
    expect(result).not.toContain(S.openCopy);
    expect(result).not.toContain(S.revealCopy);
  }
  expect(renderToStaticMarkup(<FileCopyJobsStatus />)).toContain(
    S.states.completed,
  );
});
