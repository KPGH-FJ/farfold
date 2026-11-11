import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseTaskReference,
  renderTaskRequirements,
  selectTaskRequirements,
  taskReferencePath,
  taskStatusPath,
  resolveTaskProgress,
} from "./agent-task-reference.mjs";

export function parseTaskArguments(args) {
  const ids = [];
  const packages = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i].toUpperCase();
    if (value === "--PACKAGE") {
      const next = args[++i];
      if (!next || !/^[A-NXZ](,[A-NXZ])*$/i.test(next))
        throw new Error("--package 需要工作包ID，例如 B,C,K。");
      packages.push(...next.toUpperCase().split(","));
    } else if (/^(ARCH-\d+|NEW-\d+|P\d+|H\d+)$/.test(value)) ids.push(value);
    else throw new Error(`无效参数：${args[i]}`);
  }
  if (!ids.length)
    throw new Error("请至少指定一个任务ID；不会默认输出全量明细。");
  return { ids, packages };
}

export function readTaskRequirements(args) {
  const { ids, packages } = parseTaskArguments(args);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const reference = resolveTaskProgress(
    parseTaskReference(readFileSync(resolve(root, taskReferencePath), "utf8")),
    readFileSync(resolve(root, taskStatusPath), "utf8"),
  );
  return renderTaskRequirements(
    selectTaskRequirements(reference, ids, packages),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(readTaskRequirements(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    console.error("用法：corepack pnpm docs:task P13 NEW-24 --package B,C,K");
    process.exitCode = 1;
  }
}
