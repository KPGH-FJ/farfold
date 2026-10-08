// Only pristine review fixtures may receive demo preparation. Explicit removals,
// credentials/source choices and unfinished work always survive the guide.
export function reviewAgents(existing, demo, baseline) {
  return existing.map((agent) => {
    const pristine = baseline.find((item) => item.id === agent.id);
    if (!pristine || JSON.stringify(agent) !== JSON.stringify(pristine))
      return agent;
    return demo.find((item) => item.id === agent.id) || agent;
  });
}
export function managementRequest() {
  return {
    view: "agents",
    active: null,
    directoryView: "added",
    contextView: "agents",
    contextActive: null,
    intent: "manage",
    folder: "",
  };
}
export function preparationSelection(entry, choice) {
  return entry?.contextView === "agents" && entry?.intent === "manage"
    ? null
    : (entry?.choice ?? choice);
}
