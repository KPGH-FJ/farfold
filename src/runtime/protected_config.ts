import type { ConfigOptionView, ThreadState } from "./session_types";
import { modelConfigOption } from "./session_projection";

export function isThoughtConfigOption(option: ConfigOptionView): boolean {
  return (
    option.category === "thought_level" ||
    (!option.category &&
      ["thought_level", "reasoning_effort"].includes(option.id))
  );
}

/** The original IDs remain protected when a later declaration changes their category. */
export function protectedConfigIds(
  options: ConfigOptionView[],
  recorded: readonly string[] = [],
): Set<string> {
  const ids = new Set(recorded);
  for (const option of options)
    if (option.category === "model" || isThoughtConfigOption(option))
      ids.add(option.id);
  // Keep the existing category-less model declaration compatibility, without
  // treating new categories such as model_config as model selection.
  const legacy = options.some((option) => option.category === "model")
    ? null
    : modelConfigOption(options.filter((option) => !option.category));
  if (legacy) ids.add(legacy.id);
  return ids;
}

export function fixedConfigOption(thread: ThreadState, id: string): boolean {
  return (
    (thread.identity === "established" || thread.resumed) &&
    protectedConfigIds(
      thread.configOptions,
      thread.configCheck?.protectedIds,
    ).has(id)
  );
}

export function protectedConfigOptions(
  options: ConfigOptionView[],
  recorded?: readonly string[],
): ConfigOptionView[] {
  const ids = protectedConfigIds(options, recorded);
  return options.filter((option) => ids.has(option.id));
}
