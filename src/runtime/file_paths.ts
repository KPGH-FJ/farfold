/** Display and URI conversion only. Filesystem access is revalidated by Rust. */
export function isAbsoluteFilePath(path: string): boolean {
  if (!path || path.startsWith("\\\\.\\") || /[\u0000-\u001f\u007f]/.test(path))
    return false;
  return (
    path.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(path) ||
    /^\\\\\?\\[a-z]:\\/i.test(path) ||
    /^\\\\(?:\?\\UNC\\)?[^\\/?]+[\\/][^\\/?]+(?:[\\/]|$)/i.test(path)
  );
}

/** Input spelling only; existence, redirection and identity require backend checks. */
export function isLocalProgramPath(path: string): boolean {
  if (!isAbsoluteFilePath(path)) return false;
  if (path.startsWith("/"))
    return !path
      .slice(1)
      .split("/")
      .some((p) => !p || p === "." || p === "..");
  const drive = /^(?:[a-z]:[\\/]|\\\\\?\\[a-z]:\\)/i.exec(path);
  if (!drive) return false;
  const tail = path.slice(drive[0].length);
  if (path.startsWith("\\\\?\\") && tail.includes("/")) return false;
  return tail.split(/[\\/]/).every((part) => {
    const stem = part.split(".")[0].toUpperCase();
    return (
      !!part &&
      part !== "." &&
      part !== ".." &&
      part.length <= 255 &&
      !/[.: ]$/.test(part) &&
      !/[:/\\?*"<>|]/.test(part) &&
      !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/.test(stem)
    );
  });
}

export function fileBasename(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  const separator = windows ? /[\\/]/ : /\//;
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  return trimmed.split(separator).pop() || trimmed || path;
}

/** RFC 8089 local/drive/explicit UNC form; encode names, never their separators. */
export function filePathUri(raw: string): string {
  if (!isAbsoluteFilePath(raw) || raw.startsWith("\\\\.\\"))
    throw new Error("invalid absolute file path");
  let path = raw
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
  const drive = /^[a-z]:[\\/]/i.test(path);
  const unc = path.startsWith("\\\\");
  if (drive || unc) path = path.replace(/\\/g, "/");
  const encode = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  if (unc) {
    const slash = path.indexOf("/", 2);
    if (slash < 0) throw new Error("invalid UNC file path");
    const host = path.slice(2, slash);
    if (!/^[a-z0-9._-]+$/i.test(host)) throw new Error("invalid UNC host");
    return `file://${host}${encode(path.slice(slash))}`;
  }
  return drive
    ? `file:///${path.slice(0, 2)}${encode(path.slice(2))}`
    : `file://${encode(path)}`;
}

/** Joining only a protocol-returned relative candidate; backend checks containment. */
export function projectFileUri(root: string, relative: string): string {
  if (
    !relative ||
    isAbsoluteFilePath(relative) ||
    /^[a-z][a-z0-9+.-]*:/i.test(relative) ||
    /[\u0000-\u001f\u007f]/.test(relative)
  )
    throw new Error("invalid relative file path");
  const windows = /^[a-z]:[\\/]/i.test(root) || root.startsWith("\\\\");
  const separator = windows ? /[\\/]/ : /\//;
  if (relative.split(separator).some((part) => part === ".."))
    throw new Error("invalid relative file path");
  return filePathUri(
    `${root.replace(windows ? /[\\/]+$/ : /\/+$/, "")}/${relative}`,
  );
}
