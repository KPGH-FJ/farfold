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
    let path = href;
    if (/^file:\/\//i.test(href)) {
      const url = new URL(href);
      if (
        (url.hostname && url.hostname !== "localhost") ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        (url.hash && !SOURCE_HASH.test(url.hash))
      )
        return { kind: "unavailable" };
      path = withoutSourcePosition(url.pathname);
    } else if (
      (/^[a-z][a-z0-9+.-]*:/i.test(href) &&
        !/^[^:/]+\.[^:/]+:\d+(?::\d+)?$/.test(href)) ||
      href.startsWith("//")
    ) {
      return { kind: "unavailable" };
    } else {
      path = withoutSourcePosition(path);
    }
    path = decodeURIComponent(path);
    if (!plain(path) || path.startsWith("#") || path.startsWith("//"))
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
    !/^(?:\/(?!\/)|\.{1,2}\/)/.test(value) ||
    /[|;&<>`$]/.test(value) ||
    /\s(?:--?[^/\s]|\/|\.{1,2}\/|[a-zA-Z_]\w*=)/.test(value)
  )
    return null;
  return withoutSourcePosition(value);
}
