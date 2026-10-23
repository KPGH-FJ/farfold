param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_:]+$')]
  [string]$Filter
)

$ErrorActionPreference = 'Stop'
# Keep the original group inventories and expected counts unchanged. These
# complete names belong to the separate current capability cohort. An unknown
# additional test still fails the historical runner's exact name/count check.
$excluded = @(switch -CaseSensitive ($Filter) {
  'file_access::material_carrier_fragment::tests::' {
    'file_access::material_carrier_fragment::tests::empty_ordinary_native_extent_roundtrips_without_inventing_payload_or_full_security'
    'file_access::material_carrier_fragment::tests::empty_native_extent_requires_exact_eof_hash_and_footer_and_refuses_partial_headers'
  }
  'file_access::material_backup_io::tests::' {
    'file_access::material_backup_io::tests::direct_inspection_requires_real_eof_and_retires_original_context_once'
    'file_access::material_backup_io::tests::direct_inspection_early_success_does_not_count_as_eof'
    'file_access::material_backup_io::tests::direct_inspection_preserves_native_error_and_unknown_abort_ownership'
    'file_access::material_backup_io::tests::direct_inspection_budget_or_cancel_after_actual_read_still_aborts_once'
  }
  'worktrees::recovery_pack::private_graph::tests::' {
    'worktrees::recovery_pack::private_graph::tests::actual_generated_graph_becomes_a_frozen_independent_git_tree_and_rejects_extra_names'
    'worktrees::recovery_pack::private_graph::tests::actual_prepared_git_enters_complete_mixed_material_under_its_original_leaf'
  }
  'file_access::material_carrier_records::tests::' {
    'file_access::material_carrier_records::tests::security_extent_is_exact_for_each_physical_order_and_not_an_ordinary_facet'
    'file_access::material_carrier_records::tests::single_default_payload_proof_keeps_exact_range_hash_and_rejects_other_facets'
    'file_access::material_carrier_records::tests::single_default_payload_never_bypasses_flags_or_complete_framing'
    'file_access::material_carrier_records::tests::material_semantic_digest_uses_all_streams_without_backup_order'
    'file_access::material_carrier_records::tests::ordinary_payload_is_explicit_and_cannot_accept_or_downgrade_full_security'
    'file_access::material_carrier_records::tests::ordinary_observed_empty_default_needs_no_physical_backup_record'
    'file_access::material_carrier_records::tests::ordinary_omitted_zero_default_keeps_exact_named_data_and_ea_semantics'
    'file_access::material_carrier_records::tests::ordinary_empty_default_exception_cannot_hide_missing_or_invalid_material'
  }
  'file_access::material_directory_records::tests::' {
    'file_access::material_directory_records::tests::full_directory_security_extent_tracks_original_bytes_without_payload_downgrade'
    'file_access::material_directory_records::tests::material_semantic_digest_retains_directory_ads_and_security_without_backup_order'
  }
  'file_access::material_mixed_tree_records::tests::' {
    'file_access::material_mixed_tree_records::tests::more_than_sixty_four_nodes_keep_every_identity_edge_and_shared_budget_limit'
    'file_access::material_mixed_tree_records::tests::expanded_collision_checks_share_work_and_cancel_before_further_comparisons'
    'file_access::material_mixed_tree_records::tests::finite_node_bound_rejects_before_allocating_or_emitting_tree_bytes'
    'file_access::material_mixed_tree_records::tests::ordinary_empty_directory_has_explicit_facets_and_does_not_relabel_full_tree'
  }
})
$arguments = @($Filter)
if ($Filter -ceq 'worktrees::git::source_roots::profile::tests::') {
  # These parents have their own eight-case cohort. The fixed ignored child is
  # called only by its XDG parent, and is not a fourth independent control.
  $nullManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-null-attributes-cases.json') -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($nullManifest.schema -ne 1 -or @($nullManifest.cases).Count -ne 8) { throw 'Null-attributes inventory is missing' }
  $nullParents = @(
    'worktrees::git::source_roots::profile::tests::null_attributes::actual_attribute_command_keeps_system_policy_separate_and_file_pin_live'
    'worktrees::git::source_roots::profile::tests::null_attributes::actual_null_lookalikes_keep_rooted_and_drive_relative_paths_rejected'
    'worktrees::git::source_roots::profile::tests::null_attributes::actual_owned_xdg_defaults_disabled_missing_file_and_raw_changes'
  )
  foreach ($test in $nullParents) {
    $entry = @($nullManifest.cases | Where-Object { $_.test -ceq $test })
    if ($entry.Count -ne 1 -or $entry[0].manual -isnot [bool] -or $entry[0].manual) { throw 'Historical exclusion is not an exact ordinary null-attributes parent' }
    $arguments += @('--skip', $test)
  }
  $arguments += @('--skip', 'worktrees::git::source_roots::profile::tests::null_attributes::owned_xdg_global_attributes_child')
}
if ($excluded.Count -gt 0) {
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-capability-closeout-cases.json') -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($manifest.schema -ne 1 -or @($manifest.cases).Count -lt 1) { throw 'Current capability inventory is missing' }
  $current = @($manifest.cases | ForEach-Object { $_.test })
  if (@($excluded | Select-Object -Unique).Count -ne $excluded.Count) { throw 'Duplicate historical exclusion' }
  foreach ($test in $excluded) {
    if (-not $test.StartsWith($Filter, [StringComparison]::Ordinal) -or $current -cnotcontains $test) { throw 'Historical exclusion is not an exact current-cohort test' }
    $arguments += @('--skip', $test)
  }
}
$arguments
