import { open } from "@tauri-apps/plugin-dialog";
let directory: Promise<string | null> | null = null;
/** One native chooser at a time, including repeated clicks before React paints. */
export function chooseDirectory(defaultPath?: string): Promise<string | null> {
  if (directory) return directory;
  directory = open({ directory: true, multiple: false, defaultPath })
    .then((path) => (typeof path === "string" ? path : null))
    .finally(() => {
      directory = null;
    });
  return directory;
}
