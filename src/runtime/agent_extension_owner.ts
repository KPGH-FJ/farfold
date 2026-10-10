import type { AgentRow } from "./agents";
type Selection = Pick<
  AgentRow,
  "id" | "source" | "command" | "args" | "env" | "createdAt" | "updatedAt"
>;
function same(a: Selection, b: Selection) {
  return (
    a.id === b.id &&
    a.source === b.source &&
    a.command === b.command &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.args.length === b.args.length &&
    a.args.every((v, i) => v === b.args[i]) &&
    a.env.length === b.env.length &&
    a.env.every(([k, v], i) => k === b.env[i][0] && v === b.env[i][1])
  );
}
/** Memory only. No fingerprint, launch details or environment leaves this tracker. */
export class AgentExtensionOwners {
  private entries = new Map<string, { selection: Selection; token: object }>();
  update(rows: readonly AgentRow[]): ReadonlyMap<string, object> {
    const next = new Map<string, { selection: Selection; token: object }>();
    for (const row of rows) {
      const previous = this.entries.get(row.id);
      const token =
        previous && same(previous.selection, row) ? previous.token : {};
      next.set(row.id, {
        selection: {
          id: row.id,
          source: row.source,
          command: row.command,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          args: [...row.args],
          env: row.env.map(([k, v]) => [k, v]),
        },
        token,
      });
    }
    this.entries = next;
    return new Map([...next].map(([id, entry]) => [id, entry.token]));
  }
}
