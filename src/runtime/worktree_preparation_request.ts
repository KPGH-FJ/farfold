import {
  preparationProjectPath,
  validPreparationSubdirectory,
  type PreparationInspection,
} from "./worktree_preparation_types";
import { WORKTREE_PREPARATION_STRINGS as S } from "./worktree_preparation_strings";

export type PreparationRequest = Readonly<{
  task: string;
  projectRelativePath: string;
  service: boolean;
  port: string;
}>;
export function validPreparationRequest(request: PreparationRequest): boolean {
  return (
    request.task.trim().length > 0 &&
    request.task.length <= 4000 &&
    validPreparationSubdirectory(request.projectRelativePath) &&
    (!request.service ||
      request.port === "" ||
      (/^[0-9]{1,5}$/.test(request.port) &&
        Number(request.port) >= 1 &&
        Number(request.port) <= 65535))
  );
}
/** The complete text is reviewed before insertion; never a shell command. */
export function preparationRequestText(
  cwd: string,
  request: PreparationRequest,
  inspection: PreparationInspection | null,
): string {
  if (!validPreparationRequest(request)) throw new Error(S.invalid);
  const project = preparationProjectPath(cwd, request.projectRelativePath);
  if (
    inspection &&
    (inspection.location.path !== cwd || inspection.projectPath !== project)
  )
    throw new Error(S.stale);
  const observations = inspection
    ? [
        S.request.scope(inspection.projectPath),
        ...inspection.facts.map(
          (fact) => `- ${fact.name}：${S.kinds[fact.nodeKind]}`,
        ),
        inspection.coverage.complete ? S.complete : S.incomplete,
      ]
    : [S.manualBoundary];
  return [
    S.request.project(project),
    S.request.task(request.task.trim()),
    ...observations,
    request.service
      ? request.port
        ? S.request.desiredPort(request.port)
        : S.request.choosePort
      : S.request.noService,
    S.request.execution,
    S.request.protect,
    S.request.results,
    S.isolation,
  ].join("\n\n");
}
