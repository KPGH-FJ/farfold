(function () {
  if (globalThis.__farfoldMonitored) return globalThis.__farfoldManualVersion;
  globalThis.__farfoldMonitored = true;
  globalThis.__farfoldManualVersion = 0;
  const report = globalThis.__farfoldManualActivity;
  for (const type of ["pointerdown", "keydown"]) {
    addEventListener(
      type,
      (event) => {
        // Never inspect keys, field values, clipboard, or page messages.
        if (event.isTrusted)
          report(String(++globalThis.__farfoldManualVersion));
      },
      true,
    );
  }
  return globalThis.__farfoldManualVersion;
});
