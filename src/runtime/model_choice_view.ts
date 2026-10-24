import type { ConfigChoice } from "./session_types";

export interface ModelChoiceView extends ConfigChoice {
  key: string;
  detail: string;
  searchTerms: readonly string[];
}

/** One UI action per declared wire value within its exact source. The original
 * configuration and all of its descriptive variants remain untouched. */
export function modelChoiceView(
  scope: readonly string[],
  choices: readonly ConfigChoice[],
): ModelChoiceView[] {
  const rows = new Map<
    string,
    {
      first: ConfigChoice;
      names: Set<string>;
      groups: Set<string>;
      descriptions: Set<string>;
    }
  >();
  for (const choice of choices) {
    const key = JSON.stringify([...scope, choice.value]);
    let row = rows.get(key);
    if (!row) {
      row = {
        first: choice,
        names: new Set(),
        groups: new Set(),
        descriptions: new Set(),
      };
      rows.set(key, row);
    }
    row.names.add(choice.name);
    if (choice.group) row.groups.add(choice.group);
    if (choice.description) row.descriptions.add(choice.description);
  }
  const nameCounts = new Map<string, number>();
  for (const { first } of rows.values())
    nameCounts.set(first.name, (nameCounts.get(first.name) ?? 0) + 1);
  return [...rows].map(([key, { first, names, groups, descriptions }]) => {
    const details = new Set([
      ...[...names].filter((name) => name !== first.name),
      ...groups,
      ...descriptions,
    ]);
    // Same names do not imply the same choice. Preserve both actions and expose
    // their actual values, without deriving a model/provider from a label.
    if ((nameCounts.get(first.name) ?? 0) > 1) details.add(first.value);
    return {
      ...first,
      key,
      detail: [...details].join(" · "),
      searchTerms: [first.value, ...names, ...groups, ...descriptions],
    };
  });
}
