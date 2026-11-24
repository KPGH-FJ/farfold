const frontendInput =
  /^(?:src\/|public\/|assets\/|(?:package\.json|pnpm-lock\.yaml|index\.html)$|(?:tsconfig|vite|vitest)\.)/;
const nativeInput = /^(?:src-tauri\/|rust-toolchain(?:\.toml)?$)/;
const checkPolicy =
  /^(?:\.github\/|scripts\/|plans\/|(?:AGENTS|PRODUCT)\.md$|docs\/(?:development-delivery|agent-access-requirements)\.md$|\.(?:gitattributes|gitignore|prettierignore|npmrc)$|(?:package\.json|pnpm-lock\.yaml)$|(?:tsconfig|vite|vitest)\.)/;
const testOnly =
  /(?:\.(?:test|spec)(?:[.-]|$)|(?:^|\/)(?:tests|__tests__)\/|_tests\.rs$)/;

// These module edges are guarded by cfg(windows) in worktrees/mod.rs or
// worktrees/create.rs. A filename alone does not prove platform applicability.
const worktrees = "src-tauri/src/worktrees/";
const windowsWorktreeSources = new Set(
  [
    "create_windows.rs",
    "windows_git.rs",
    "windows_offline_program.rs",
    "windows_scope.rs",
  ].map((file) => worktrees + file),
);
const windowsWorktreeTests = new Set(
  [
    "create_windows_tests.rs",
    "create_observation_tests.rs",
    "windows_tests.rs",
  ].map((file) => worktrees + file),
);
const sharedWindowsWorktreePaths = new Set(
  ["create.rs", "mod.rs", "tests.rs"].map((file) => worktrees + file),
);
// mod.rs declares this module with cfg(test); the helpers exercise both OSes.
const sharedWorktreeTests = `${worktrees}tests.rs`;

export function classifyDeliveryPaths(paths) {
  if (
    !Array.isArray(paths) ||
    !paths.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        !path.split("/").some((part) => ["", ".", ".."].includes(part)),
    )
  ) {
    throw new Error("Expected repository-relative changed paths.");
  }
  const frontend = paths.some((path) => frontendInput.test(path));
  const native = paths.some((path) => nativeInput.test(path));
  const isWindowsOnly = (path) =>
    windowsWorktreeSources.has(path) || windowsWorktreeTests.has(path);
  const macNative = paths.some(
    (path) => nativeInput.test(path) && !isWindowsOnly(path),
  );
  const windowsNative = paths.some(
    (path) => isWindowsOnly(path) || sharedWindowsWorktreePaths.has(path),
  );
  const isTest = (path) =>
    path === sharedWorktreeTests ||
    ((path.startsWith("src/") || path.startsWith("src-tauri/")) &&
      testOnly.test(path));
  const macProduct = paths.some(
    (path) =>
      (frontendInput.test(path) || nativeInput.test(path)) &&
      !isWindowsOnly(path) &&
      !isTest(path) &&
      !path.startsWith("vitest."),
  );
  const windowsProduct = paths.some((path) => windowsWorktreeSources.has(path));
  const product = macProduct || windowsProduct;
  const governance = paths.some(
    (path) => checkPolicy.test(path) || isTest(path),
  );
  return {
    frontend,
    native,
    product,
    governance,
    macNative,
    windowsNative,
    macProduct,
    windowsProduct,
  };
}
