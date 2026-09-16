export type MessageLink =
  | { kind: "file"; path: string }
  | { kind: "web"; url: string }
  | { kind: "unavailable" };

// File paths stay paths: never resolve them against the webview's tauri origin.
// The Host validates existence, native identity and Working Copy membership.
export function messageLink(href: string | undefined): MessageLink {
  if (!href || href.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(href))
    return { kind: "unavailable" };
  try {
    if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
      const url = new URL(href);
      return { kind: "web", url: url.href };
    }
    let path = href;
    if (/^file:\/\//i.test(href)) {
      const url = new URL(href);
      if (url.hostname && url.hostname !== "localhost")
        return { kind: "unavailable" };
      path = url.pathname;
    } else if (
      (/^[a-z][a-z0-9+.-]*:/i.test(href) &&
        !/^[^:/]+\.[^:/]+:\d+(?::\d+)?$/.test(href)) ||
      href.startsWith("//")
    ) {
      return { kind: "unavailable" };
    }
    // Ignore only recognized source-line anchors; preserve other filename text.
    path = decodeURIComponent(
      path.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, ""),
    );
    if (
      !path ||
      path.startsWith("#") ||
      path.startsWith("//") ||
      /[\u0000-\u001f\u007f]/.test(path)
    )
      return { kind: "unavailable" };
    return { kind: "file", path };
  } catch {
    return { kind: "unavailable" };
  }
}
