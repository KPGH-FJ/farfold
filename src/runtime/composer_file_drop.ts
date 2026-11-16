import { isAbsoluteFilePath } from "./file_paths";

export type FileDropEvent =
  | {
      type: "enter" | "drop";
      paths: string[];
      position: { x: number; y: number };
    }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "leave" };
export type FileDropOwner = {
  key: string;
  generation: number;
  enabled: boolean;
};

/** A native drag belongs to the input that was active when it entered.
 * Coordinates keep their platform units until the DOM hit test. */
export function createFileDropHandler({
  owner,
  accepts,
  highlight,
  add,
}: {
  owner: () => FileDropOwner;
  accepts: (position: { x: number; y: number }) => boolean;
  highlight: (value: boolean) => void;
  add: (key: string, paths: string[]) => void;
}) {
  let gesture: FileDropOwner | null = null;
  return (event: FileDropEvent) => {
    if (event.type === "leave") {
      gesture = null;
      highlight(false);
      return;
    }
    const current = owner();
    if (event.type === "enter")
      gesture = current.enabled ? { ...current } : null;
    const accepted = Boolean(
      gesture &&
      current.enabled &&
      gesture.key === current.key &&
      gesture.generation === current.generation &&
      Number.isFinite(event.position.x) &&
      Number.isFinite(event.position.y) &&
      accepts(event.position),
    );
    if (event.type !== "drop") {
      highlight(accepted);
      return;
    }
    gesture = null;
    highlight(false);
    if (
      accepted &&
      event.paths.length &&
      event.paths.every(
        (path) => typeof path === "string" && isAbsoluteFilePath(path),
      )
    )
      add(current.key, event.paths);
  };
}

export const FILE_DROP_STRINGS = {
  release: "松开以添加文件",
  unavailable: "拖入文件暂不可用，可通过“添加文件”选择。",
} as const;
