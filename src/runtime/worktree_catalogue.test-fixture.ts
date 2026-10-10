/** Confirmed empty catalogue for tests whose subject is unrelated Agent setup. */
export const worktrees = {
  snapshot: () => ({
    ready: true,
    loading: false,
    error: null,
    locations: [],
    archives: [],
    materials: [],
    recoveries: [],
    operation: null,
    operationId: null,
    working: false,
    uncertain: false,
    maintenanceLocked: false,
  }),
  subscribe: () => () => {},
  load: async () => {},
};
