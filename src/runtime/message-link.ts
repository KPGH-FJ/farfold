import { isLocalAbsoluteFilePath, localFileUriPath } from "./file_paths";

export type MessageLink =
  | { kind: "file"; path: string }
  | { kind: "web"; url: string }
  | { kind: "unavailable" };

const SOURCE_HASH = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/;
const SOURCE_POSITION = /(\.[a-zA-Z0-9_-]+):\d+(?::\d+)?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function plain(value: string | undefined): value is string {
  return !!value && value.length <= 16 * 1024 && !CONTROL.test(value);
}

function withoutSourcePosition(path: string): string {
  return path.replace(SOURCE_HASH, "").replace(SOURCE_POSITION, "$1");
}

// Display parsing only. A user click selects one file; the existing delivery
// boundary checks the original working folder, exact target and current bytes.
export function messageLink(href: string | undefined): MessageLink {
  if (!plain(href)) return { kind: "unavailable" };
  try {
    if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
      const url = new URL(href);
      return { kind: "web", url: url.href };
    }
    if (/^file:\/\//i.test(href)) {
      const url = new URL(href);
      if (url.hash && !SOURCE_HASH.test(url.hash))
        return { kind: "unavailable" };
      url.hash = "";
      url.pathname = withoutSourcePosition(url.pathname);
      const path = localFileUriPath(url.href);
      return path && plain(path)
        ? { kind: "file", path }
        : { kind: "unavailable" };
    }
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(href) &&
      !isLocalAbsoluteFilePath(href) &&
      !/^[^:/]+\.[^:/]+:\d+(?::\d+)?$/.test(href)
    )
      return { kind: "unavailable" };
    const path = decodeURIComponent(withoutSourcePosition(href));
    if (
      !plain(path) ||
      path.startsWith("#") ||
      ((/^[\\/]/.test(path) || /^[a-z]:/i.test(path)) &&
        !isLocalAbsoluteFilePath(path))
    )
      return { kind: "unavailable" };
    return { kind: "file", path };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Only a complete path token, never arbitrary prose, a URL or a shell command.
 * Raw filesystem paths are not URI-decoded: a literal %20 stays part of a name. */
export function inlineFilePath(value: string): string | null {
  if (!plain(value) || value !== value.trim()) return null;
  if (/^file:\/\//i.test(value)) {
    const link = messageLink(value);
    return link.kind === "file" ? link.path : null;
  }
  if (
    (!isLocalAbsoluteFilePath(value) && !/^\.{1,2}[\\/]/.test(value)) ||
    /[|;&<>`$]/.test(value) ||
    /\s(?:--?[^/\s]|[\\/]|[a-z]:[\\/]|\.{1,2}[\\/]|[a-zA-Z_]\w*=)/i.test(value)
  )
    return null;
  return withoutSourcePosition(value);
}
