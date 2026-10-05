(async function (
  mode,
  epochSeed,
  observationSeed,
  navigation,
  observationId,
  nodeRef,
  kind,
  inputText,
  deadline,
  manualRevision,
) {
  // The DOM event increments synchronously. A delayed native binding callback
  // cannot let an operation approved against the previous revision read or act.
  if (globalThis.__farfoldManualVersion !== manualRevision)
    throw new Error("page changed");
  /* FARFOLD_OBSERVATION_PROGRAM */
});
