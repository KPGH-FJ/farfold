// Review-only state. Registration never grants login, credentials or entitlement.
export function registrationDestinationAddress(destination) {
  if (!destination?.verified || !destination.url) return "";
  try {
    const url = new URL(destination.url);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export function beginRegistration({
  kind = "account",
  accountLabel,
  methodId,
  selection = {},
  destination,
}) {
  return {
    kind,
    accountLabel,
    methodId,
    selection: structuredClone(selection),
    destination: structuredClone(
      destination || { label: "账号与密钥准备", verified: false },
    ),
    status: "ready",
    page: "farfold",
    attempt: 0,
    open: true,
  };
}
export function registrationTransition(state, action) {
  if (!state) return state;
  if (
    state.kind === "api" &&
    !registrationDestinationAddress(state.destination)
  ) {
    if (["return", "resume"].includes(action))
      return {
        ...state,
        status: "ready",
        page: "farfold",
        open: action === "resume",
      };
    return state;
  }
  if (action === "return") return { ...state, open: false };
  if (action === "resume") return { ...state, open: true };
  if (action === "start" && state.status === "ready")
    return {
      ...state,
      status: "waiting",
      page: "external",
      attempt: (state.attempt || 0) + 1,
    };
  if (
    action === "open-page" &&
    ["waiting", "registered", "key-issued"].includes(state.status)
  )
    return { ...state, page: "external" };
  if (action === "return-page") return { ...state, page: "farfold" };
  if (action === "fail" && state.status === "waiting")
    return { ...state, status: "failed" };
  if (action === "retry" && state.status === "failed")
    return {
      ...state,
      status: "waiting",
      page: "external",
      attempt: (state.attempt || 0) + 1,
    };
  if (action === "registered" && state.status === "waiting")
    return { ...state, status: "registered" };
  if (
    action === "existing-account" &&
    ["ready", "waiting", "failed"].includes(state.status)
  )
    return {
      ...state,
      status: "registered",
      existingAccount: true,
      page: "farfold",
    };
  if (
    action === "key-issued" &&
    state.kind === "api" &&
    state.status === "registered"
  )
    return { ...state, status: "key-issued" };
  return state;
}
