export interface PiCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commandLocation(
  command: Record<string, unknown>,
): PiCommandInfo["location"] {
  if (
    command.location === "user" ||
    command.location === "project" ||
    command.location === "path"
  ) {
    return command.location;
  }
  const scope = asRecord(command.sourceInfo)?.scope;
  return scope === "user" || scope === "project" ? scope : undefined;
}

export function parsePiCommands(value: unknown): PiCommandInfo[] {
  return (Array.isArray(value) ? value : []).flatMap((candidate) => {
    const command = asRecord(candidate);
    const source = command?.source;
    if (
      !command ||
      typeof command.name !== "string" ||
      (source !== "extension" && source !== "prompt" && source !== "skill")
    ) {
      return [];
    }
    const location = commandLocation(command);
    return [
      {
        name: command.name,
        source,
        ...(typeof command.description === "string"
          ? { description: command.description }
          : {}),
        ...(location ? { location } : {}),
      },
    ];
  });
}
