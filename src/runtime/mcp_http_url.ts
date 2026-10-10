// Validation only. Never return URL.href: the exact reviewed string is saved.
export function validMcpHttpUrl(
  value: unknown,
  restricted: (s: string) => boolean,
): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    new TextEncoder().encode(value).length > 4096 ||
    restricted(value) ||
    /[\\\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000#]/u.test(value) ||
    /%(?![0-9a-f]{2})/i.test(value)
  )
    return false;
  const prefix = /^https?:\/\//i.exec(value);
  if (!prefix) return false;
  const authority = value.slice(prefix[0].length).split(/[/?]/, 1)[0];
  if (!authority || authority.includes("@")) return false;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 2 || authority.indexOf("]", closing + 1) !== -1) return false;
    const suffix = authority.slice(closing + 1);
    if (suffix && !suffix.startsWith(":")) return false;
    if (suffix) port = suffix.slice(1);
  } else {
    if (/[\[\]]/.test(authority)) return false;
    const parts = authority.split(":");
    if (!parts[0] || parts.length > 2) return false;
    if (parts.length === 2) port = parts[1];
  }
  if (port !== undefined) {
    if (!/^[0-9]+$/.test(port)) return false;
    let number = 0;
    for (const digit of port) {
      number = number * 10 + Number(digit);
      if (number > 65535) return false;
    }
  }
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
