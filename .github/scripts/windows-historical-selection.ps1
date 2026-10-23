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
  'file_access::material_backup_io::tests::' {
    'file_access::material_backup_io::tests::direct_inspection_requires_real_eof_and_retires_original_context_once'
    'file_access::material_backup_io::tests::direct_inspection_early_success_does_not_count_as_eof'
    'file_access::material_backup_io::tests::direct_inspection_preserves_native_error_and_unknown_abort_ownership'
    'file_access::material_backup_io::tests::direct_inspection_budget_or_cancel_after_actual_read_still_aborts_once'
  }
  'worktrees::recovery_pack::private_graph::tests::' {
    'worktrees::recovery_pack::private_graph::tests::actual_generated_graph_becomes_a_frozen_independent_git_tree_and_rejects_extra_names'
  }
  'file_access::material_carrier_records::tests::' {
    'file_access::material_carrier_records::tests::material_semantic_digest_uses_all_streams_without_backup_order'
    'file_access::material_carrier_records::tests::ordinary_payload_is_explicit_and_cannot_accept_or_downgrade_full_security'
  }
  'file_access::material_directory_records::tests::' {
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
