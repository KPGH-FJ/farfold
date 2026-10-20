param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedHead,
  [Parameter(Mandatory = $true)]
  [ValidateSet('Ordinary', 'FullSecurityManual')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$selection = Get-Content -LiteralPath (Join-Path $raw 'build-selection.json') -Raw | ConvertFrom-Json
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $selection.sourceHead -cne $head) { throw 'Owned material controls head differs from selected build' }
$binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
$fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ne $selection.fixtureSha256) { throw 'Owned material controls inputs changed after build' }
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash

# Every case has exactly one FQN. FullSecurity is explicit --ignored, existing
# token only. Ordinary fake/codec/persistent-file controls are not native restore.
$cases = @(
  @{ name = 'persistent-store-01'; test = 'file_access::windows::material_persistent_store::tests::actual_fixed_file_survives_close_and_independent_reopen_without_memory_payload'; manual = $false; category = 'currentMerged21' }
  @{ name = 'persistent-store-02'; test = 'file_access::windows::material_persistent_store::tests::actual_no_replace_collision_preserves_sentinel_and_discards_only_owned_pending'; manual = $false; category = 'currentMerged21' }
  @{ name = 'persistent-store-03'; test = 'file_access::windows::material_persistent_store::tests::actual_truncation_corruption_suffix_and_wrong_whole_hash_refuse_before_publish'; manual = $false; category = 'currentMerged21' }
  @{ name = 'persistent-store-04'; test = 'file_access::windows::material_persistent_store::tests::cancelled_and_exhausted_verification_never_publish_or_leave_pending'; manual = $false; category = 'currentMerged21' }
  @{ name = 'persistent-store-05'; test = 'file_access::windows::material_persistent_store::tests::reader_pins_real_file_and_full_version_rejects_actual_write_attributes_change'; manual = $false; category = 'currentMerged21' }
  @{ name = 'persistent-owner-06'; test = 'worktrees::recovery_pack::material::tests::ordinary_source_and_foreign_reserved_stamp_never_gain_full_material_authority'; manual = $false; category = 'currentMerged21' }
  @{ name = 'persistent-owner-07'; test = 'worktrees::recovery_pack::material::tests::actual_mixed_bytes_remain_readable_after_sources_close_and_owned_source_is_removed'; manual = $true; category = 'currentMerged21' }
  @{ name = 'persistent-owner-08'; test = 'worktrees::recovery_pack::material::tests::root_git_edge_and_existing_final_refuse_without_copying_or_replacing'; manual = $true; category = 'currentMerged21' }
  @{ name = 'persistent-owner-09'; test = 'worktrees::recovery_pack::material::tests::callback_error_or_unwind_is_failure_and_leaves_published_actual_bytes_owned'; manual = $true; category = 'currentMerged21' }
  @{ name = 'target-groups-10'; test = 'worktrees::material_owner::target_link_group_tests::cross_parent_groups_keep_distinct_real_data_ea_sd_and_complete_name_identity_sets'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-11'; test = 'worktrees::material_owner::target_link_group_tests::empty_default_data_has_real_cross_parent_links_without_a_fabricated_payload'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-12'; test = 'worktrees::material_owner::target_link_group_tests::cross_parent_counted_unpaired_utf16_and_max_leaf_are_actual_names'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-13'; test = 'worktrees::material_owner::target_link_group_tests::cross_parent_replace_false_collision_preserves_both_existing_groups'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-14'; test = 'worktrees::material_owner::target_link_group_tests::invalid_names_precancel_and_insufficient_shared_work_do_not_mutate_any_group'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-15'; test = 'worktrees::material_owner::target_link_group_tests::actual_target_parent_denies_new_delete_before_and_after_cross_parent_links'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-16'; test = 'worktrees::material_owner::target_link_group_tests::caller_error_after_verified_cross_parent_effect_still_closes_original_slot'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-17'; test = 'worktrees::material_owner::target_link_group_tests::all_directory_and_member_nodes_share_one_fixed_admission_limit'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-18'; test = 'worktrees::material_owner::target_link_group_tests::undeclared_real_alias_cannot_be_forgiven_or_deleted_and_retains_the_same_slot'; manual = $false; category = 'currentMerged21' }
  @{ name = 'target-groups-19'; test = 'worktrees::material_owner::target_link_group_tests::cross_parent_groups_observe_actual_full_sd_without_claiming_source_sd_restore'; manual = $true; category = 'currentMerged21' }
  @{ name = 'managed-role-20'; test = 'worktrees::git::source_roots::graph_tests::managed_root_git_tests::real_linked_graph_retains_original_root_git_role_through_complete_recheck'; manual = $false; category = 'currentMerged21' }
  @{ name = 'managed-role-21'; test = 'worktrees::git::source_roots::graph_tests::managed_root_git_tests::actual_main_read_context_role_does_not_widen_private_graph_inventory_or_material_gate'; manual = $false; category = 'currentMerged21' }
  @{ name = 'managed-role-22'; test = 'worktrees::git::source_roots::graph_tests::managed_root_git_tests::root_git_role_does_not_accept_a_correct_pointer_to_a_nondefault_private_directory'; manual = $false; category = 'currentMerged21' }
  @{ name = 'managed-role-23'; test = 'worktrees::git::source_roots::graph_tests::managed_root_git_tests::actual_root_namespace_change_cannot_leave_original_graph_role_verified'; manual = $false; category = 'currentMerged21' }
  @{ name = 'managed-role-24'; test = 'worktrees::git::source_roots::graph_tests::managed_root_git_tests::an_original_role_capsule_cannot_be_presented_as_a_different_root_read_context'; manual = $false; category = 'currentMerged21' }
  @{ name = 'sealed-tree-25'; test = 'file_access::windows::material_persistent_store::restore::tests::stored_synthetic_typed_bytes_without_actual_facts_never_open_a_target_namespace'; manual = $false; category = 'ordinaryWindows' }
  @{ name = 'sealed-tree-26'; test = 'file_access::windows::material_persistent_store::restore::tests::missing_native_catalogue_members_refuse_before_any_target_effect'; manual = $false; category = 'ordinaryWindows' }
  @{ name = 'sealed-tree-27'; test = 'file_access::windows::material_persistent_store::restore::tests::cancelled_or_exhausted_rebuild_does_not_offer_native_write_or_erase_material'; manual = $false; category = 'ordinaryWindows' }
  @{ name = 'sealed-tree-28'; test = 'file_access::windows::material_persistent_store::restore::tests::failed_native_abort_prevents_actual_store_cleanup_and_keeps_the_same_resources'; manual = $false; category = 'ordinaryWindowsSharedApiFake' }
  @{ name = 'sealed-tree-29'; test = 'worktrees::recovery_pack::material::tests::sealed_actual_tree_reconstructs_raw_parent_edges_data_ea_ads_after_source_removal'; manual = $true; category = 'manualFullSecurity' }
  @{ name = 'sealed-tree-30'; test = 'worktrees::recovery_pack::material::tests::restored_readonly_and_restrictive_dacl_keep_original_target_delete_rights_until_cleanup'; manual = $true; category = 'manualFullSecurity' }
  @{ name = 'sealed-tree-31'; test = 'worktrees::recovery_pack::material::tests::one_store_refuses_a_second_reconstruction_while_original_targets_remain_owned'; manual = $true; category = 'manualFullSecurity' }
  @{ name = 'sealed-tree-32'; test = 'worktrees::recovery_pack::material::tests::callback_error_or_unwind_after_real_reconstruction_cleans_same_slot_and_keeps_material'; manual = $true; category = 'manualFullSecurity' }
  @{ name = 'managed-edge-01'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::real_managed_edge_keeps_original_read_context_after_outer_graph_drop_until_last_owner'; manual = $false; category = 'ownedOriginalSourceOwnerRoleAndBudget' }
  @{ name = 'managed-edge-02'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::real_foreign_root_raw_name_and_actual_foreign_edge_never_mint_an_exclusion'; manual = $false; category = 'ownedOriginalSourceOwnerRoleAndBudget' }
  @{ name = 'managed-edge-03'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::managed_recheck_uses_original_shared_work_and_cancel_without_advancing_source'; manual = $false; category = 'ownedOriginalSourceOwnerRoleAndBudget' }
  @{ name = 'managed-edge-04'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::actual_worktree_capsule_excludes_only_root_git_and_keeps_nested_git_bytes_after_source_close'; manual = $true; category = 'manualFullSecurityNoFallback' }
  @{ name = 'managed-edge-05'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::actual_managed_private_namespace_change_during_consumer_fails_final_source_fence'; manual = $true; category = 'manualFullSecurityNoFallback' }
  @{ name = 'managed-edge-06'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::actual_same_pinned_inventory_query_charges_returned_bytes_and_preserves_complete_legacy_listing'; manual = $false; category = 'ordinaryWindowsOwnedReaderOrSamePinnedActualQuery' }
  @{ name = 'managed-edge-07'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::actual_git_metadata_reader_keeps_complete_eof_for_zero_small_and_existing_file_limit'; manual = $false; category = 'ordinaryWindowsOwnedReaderOrSamePinnedActualQuery' }
  @{ name = 'managed-edge-08'; test = 'worktrees::git::source_roots::graph_tests::managed_material_tests::actual_git_metadata_growth_shrink_cancel_and_over_limit_refuse_with_size_plus_one_offer'; manual = $false; category = 'ordinaryWindowsOwnedReaderOrSamePinnedActualQuery' }
  @{ name = 'owned-link255-1'; test = 'worktrees::material_owner::owned_link_tests::empty_255unit_owned_link_keeps_established_archive_and_exact_empty_facets'; manual = $false; category = 'ordinaryOwnedNtfs255WithOriginalResultAndLimitedCompanion' }
  @{ name = 'owned-link255-2'; test = 'worktrees::material_owner::owned_link_tests::filled_255unit_alias_keeps_same_fileobject_diagnostics_and_original_result'; manual = $false; category = 'ordinaryOwnedNtfs255WithOriginalResultAndLimitedCompanion' }
)
$ordinaryCount = @($cases | Where-Object { -not $_.manual }).Count
$manualCount = @($cases | Where-Object { $_.manual }).Count
$names = @($cases | ForEach-Object { $_.test })
$labels = @($cases | ForEach-Object { $_.name })
if ($cases.Count -ne 42 -or $ordinaryCount -ne 32 -or $manualCount -ne 10 -or @($names | Select-Object -Unique).Count -ne 42 -or @($labels | Select-Object -Unique).Count -ne 42) { throw 'Owned material closed case inventory changed' }
$manualMode = $Mode -ceq 'FullSecurityManual'
$selected = @($cases | Where-Object { $_.manual -eq $manualMode })
$expected = if ($manualMode) { 10 } else { 32 }
if ($selected.Count -ne $expected) { throw 'Owned material mode inventory differs' }
$results = @()
$complete = $true
foreach ($case in $selected) {
  $prefix = 'owned-material-' + $Mode + '-' + $case.name
  $stdout = Join-Path $raw ($prefix + '.stdout.log')
  $stderr = Join-Path $raw ($prefix + '.stderr.log')
  $started = [DateTime]::UtcNow.ToString('o')
  $selectionArguments = @('--exact')
  if ($manualMode) { $selectionArguments = @('--ignored', '--exact') }
  & $binary $case.test @selectionArguments --nocapture --test-threads=1 1> $stdout 2> $stderr
  $testExit = $LASTEXITCODE
  $finished = [DateTime]::UtcNow.ToString('o')
  $outText = [IO.File]::ReadAllText($stdout)
  $summaries = [regex]::Matches($outText, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
  $last = if ($summaries.Count -eq 1) { $summaries[0] } else { $null }
  $nameMatches = [regex]::Matches($outText, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. ok\r?$')
  $actualNames = @($nameMatches | ForEach-Object { $_.Groups['name'].Value })
  $namesExact = $actualNames.Count -eq 1 -and $actualNames[0] -ceq $case.test
  $passed = $testExit -eq 0 -and $null -ne $last -and $last.Groups['status'].Value -ceq 'ok' -and $last.Groups['passed'].Value -eq '1' -and $last.Groups['failed'].Value -eq '0' -and $last.Groups['ignored'].Value -eq '0' -and $namesExact
  if (-not $passed) { $complete = $false }
  $outcomes = @([regex]::Matches($outText, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. (?<outcome>ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$') | ForEach-Object {
    [ordered]@{ name = $_.Groups['name'].Value; outcome = $_.Groups['outcome'].Value }
  })
  $entry = [ordered]@{
    group = $case.name; filter = $case.test; category = $case.category
    explicitIgnored = $manualMode; exactFilter = $true
    expectedTests = 1; expectedNames = @($case.test)
    actualPassedNames = $actualNames; actualNamedOutcomes = $outcomes
    startedAtUtc = $started; finishedAtUtc = $finished; exitCode = $testExit
    summaryCount = $summaries.Count; finalSummary = if ($last) { $last.Value } else { $null }
    namesExact = $namesExact; exactGroupPassed = $passed
    stdoutSha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash
    stderrSha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash
  }
  $results += $entry
  $entry | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.result.json')) -Encoding utf8
  Get-Content -LiteralPath $stdout
  Get-Content -LiteralPath $stderr
}
$finalHead = (& git rev-parse HEAD).Trim()
$headStable = $LASTEXITCODE -eq 0 -and $finalHead -ceq $head
$inputsStable = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -eq $selection.testBinarySha256 -and (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $selection.fixtureSha256 -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -eq $scriptHash
$complete = $complete -and $results.Count -eq $expected -and $headStable -and $inputsStable
[ordered]@{
  schema = 1; head = $head; finalHead = $finalHead; headStable = $headStable
  mode = $Mode; testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
  runnerScriptSha256 = $scriptHash; inputsStable = $inputsStable
  plannedOrdinaryTests = 32; plannedManualTests = 10; plannedTotalTests = 42
  selectedTests = $expected; groupCount = $results.Count; groups = $results; exactAllGroupsPassed = $complete
  oldCarrier149CountChanged = $false; oldContinuation30CountChanged = $false
  explicitManualFailuresAreSuccessfulTests = $false; privilegesAdjusted = $false; fullSecurityFallbackUsed = $false
  syntheticOrOrdinaryRefusalIsNativeSuccess = $false; completePayloadSecurityOrAliasRestoreClaim = $false
  fullTreeOrManifest2Complete = $false; productOrAllWindowsComplete = $false
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $raw ('owned-material-' + $Mode + '.result.json')) -Encoding utf8
Get-Content -LiteralPath (Join-Path $raw ('owned-material-' + $Mode + '.result.json'))
if (-not $complete) { exit 1 }
exit 0
