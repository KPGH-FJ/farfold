const frontendInput =
  /^(?:src\/|public\/|assets\/|(?:package\.json|pnpm-lock\.yaml|index\.html)$|(?:tsconfig|vite|vitest)\.)/;
const nativeInput = /^(?:src-tauri\/|rust-toolchain(?:\.toml)?$)/;
const agentInstructions = /(?:^|\/)AGENTS(?:\.override)?\.md$/;
const checkPolicy =
  /^(?:\.github\/|scripts\/|plans\/|PRODUCT\.md$|docs\/(?:development-delivery|agent-access-requirements)\.md$|\.(?:gitattributes|gitignore|prettierignore|npmrc)$|(?:package\.json|pnpm-lock\.yaml)$|(?:tsconfig|vite|vitest)\.)/;
const testOnly =
  /(?:\.(?:test|spec)(?:[.-]|$)|(?:^|\/)(?:tests|__tests__)\/|_tests\.rs$)/;

// The path lists follow the Rust module declarations under worktrees/mod.rs,
// including cfg conditions inherited from parent modules.
const worktrees = "src-tauri/src/worktrees/";
const windowsWorktreeSources = new Set(
  [
    "create_windows.rs",
    "git_bundle_output_windows.rs",
    "git_debug_windows.rs",
    "git_recovered_source_windows.rs",
    "git_selected_checkout_windows.rs",
    "git_source_checkout_evaluator_windows.rs",
    "git_source_checkout_inputs_windows.rs",
    "git_source_checkout_windows.rs",
    "git_source_delete_windows.rs",
    "git_source_export_windows.rs",
    "git_source_frozen_windows.rs",
    "git_source_managed_material_windows.rs",
    "git_source_roots_windows.rs",
    "material_owner_remove.rs",
    "material_windows.rs",
    "preparation_windows.rs",
    "private_bare_windows.rs",
    "private_bundle_graph_windows.rs",
    "private_offline_graph_windows.rs",
    "recovery_artifact_windows.rs",
    "recovery_graph.rs",
    "recovery_material_windows.rs",
    "recovery_prepare_git_windows.rs",
    "recovery_prepared_git_windows.rs",
    "recycle_windows.rs",
    "remove_windows.rs",
    "windows_git.rs",
    "windows_git_paths.rs",
    "windows_offline_program.rs",
    "windows_scope.rs",
    "windows_scope_managed_git.rs",
    "windows_scope_move.rs",
    "windows_scope_remove.rs",
  ].map((file) => worktrees + file),
);
const windowsWorktreeTests = new Set(
  [
    "create_observation_tests.rs",
    "create_windows_tests.rs",
    "git_command_observation_tests.rs",
    "git_settlement_observation_tests.rs",
    "git_settlement_windows_tests.rs",
    "git_source_checkout_null_attributes_windows_tests.rs",
    "git_source_checkout_windows_tests.rs",
    "git_source_content_windows_tests.rs",
    "material_alias_topology_owner_tests.rs",
    "material_backup_shape_owner_tests.rs",
    "material_carrier_owner_tests.rs",
    "material_directory_carrier_owner_tests.rs",
    "material_directory_restore_owner_tests.rs",
    "material_directory_tree_owner_tests.rs",
    "material_mixed_tree_owner_tests.rs",
    "material_owned_link_owner_tests.rs",
    "material_regular_shared_owner_tests.rs",
    "material_target_link_group_owner_tests.rs",
    "material_windows_entry_pair_tests.rs",
    "preparation_windows_cache_tests.rs",
    "preparation_windows_tests.rs",
    "private_bare_windows_tests.rs",
    "private_bundle_graph_windows_tests.rs",
    "private_offline_graph_windows_tests.rs",
    "recovery_cold_windows_tests.rs",
    "recovery_material_windows_tests.rs",
    "recovery_ordinary_windows_tests.rs",
    "recovery_public_windows_tests.rs",
    "recovery_windows_diagnostics.rs",
    "recycle_windows_pointer_tests.rs",
    "recycle_windows_tests.rs",
    "remove_native_windows_tests.rs",
    "source_export_pairing_windows_tests.rs",
    "source_graph_managed_material_tests.rs",
    "source_graph_windows_tests.rs",
    "source_pack_windows_tests.rs",
    "source_roots_windows_tests.rs",
    "windows_git_launch_matrix_tests.rs",
    "windows_git_paths_tests.rs",
    "windows_git_plain_paths_tests.rs",
    "windows_managed_git_edge_tests.rs",
    "windows_scope_remove_tests.rs",
    "windows_tests.rs",
  ].map((file) => worktrees + file),
);
// These modules have Windows production behavior and are also built for macOS tests.
const windowsProductionWithSharedTests = new Set(
  ["material_links.rs", "read_policy.rs"].map((file) => worktrees + file),
);
// Shared parents of Windows modules and shared test entry points.
const sharedWindowsWorktreePaths = new Set(
  [
    "checkout.rs",
    "create.rs",
    "git.rs",
    "git_content_stream.rs",
    "git_content_stream_tests.rs",
    "manager.rs",
    "material_links_tests.rs",
    "material_owner.rs",
    "material_scan.rs",
    "mod.rs",
    "preparation_manager.rs",
    "recovery_artifact.rs",
    "recovery_pack.rs",
    "recycle.rs",
    "removal.rs",
    "tests.rs",
  ].map((file) => worktrees + file),
);
const sharedWorktreeTestModules = new Set(
  ["git_content_stream.rs", "tests.rs"].map((file) => worktrees + file),
);

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
  const implementationPaths = paths.filter(
    (path) => !agentInstructions.test(path),
  );
  const frontend = implementationPaths.some((path) => frontendInput.test(path));
  const native = implementationPaths.some((path) => nativeInput.test(path));
  const isWindowsOnly = (path) =>
    windowsWorktreeSources.has(path) || windowsWorktreeTests.has(path);
  const macNative = implementationPaths.some(
    (path) => nativeInput.test(path) && !isWindowsOnly(path),
  );
  const windowsNative = paths.some(
    (path) =>
      isWindowsOnly(path) ||
      windowsProductionWithSharedTests.has(path) ||
      sharedWindowsWorktreePaths.has(path),
  );
  const isTest = (path) =>
    windowsWorktreeTests.has(path) ||
    sharedWorktreeTestModules.has(path) ||
    ((path.startsWith("src/") || path.startsWith("src-tauri/")) &&
      testOnly.test(path));
  const macProduct = implementationPaths.some(
    (path) =>
      (frontendInput.test(path) || nativeInput.test(path)) &&
      !isWindowsOnly(path) &&
      !windowsProductionWithSharedTests.has(path) &&
      !isTest(path) &&
      !path.startsWith("vitest."),
  );
  const windowsProduct = paths.some(
    (path) =>
      windowsWorktreeSources.has(path) ||
      windowsProductionWithSharedTests.has(path),
  );
  const product = macProduct || windowsProduct;
  const governance = paths.some(
    (path) =>
      checkPolicy.test(path) || agentInstructions.test(path) || isTest(path),
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
