const frontendInput =
  /^(?:src\/|public\/|assets\/|(?:package\.json|pnpm-lock\.yaml|index\.html)$|(?:tsconfig|vite|vitest)\.)/;
const nativeInput = /^(?:src-tauri\/|rust-toolchain(?:\.toml)?$)/;
const checkPolicy =
  /^(?:\.github\/|scripts\/|plans\/|(?:AGENTS|PRODUCT)\.md$|docs\/(?:development-delivery|agent-access-requirements)\.md$|\.(?:gitattributes|gitignore|prettierignore|npmrc)$|(?:package\.json|pnpm-lock\.yaml)$|(?:tsconfig|vite|vitest)\.)/;
const testOnly =
  /(?:\.(?:test|spec)(?:[.-]|$)|(?:^|\/)(?:tests|__tests__)\/|_tests\.rs$)/;

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
  const isTest = (path) =>
    (path.startsWith("src/") || path.startsWith("src-tauri/")) &&
    testOnly.test(path);
  const product = paths.some(
    (path) =>
      (frontendInput.test(path) || nativeInput.test(path)) &&
      !isTest(path) &&
      !path.startsWith("vitest."),
  );
  const governance = paths.some(
    (path) => checkPolicy.test(path) || isTest(path),
  );
  return { frontend, native, product, governance };
}
