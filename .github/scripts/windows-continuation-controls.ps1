param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedHead
)

$ErrorActionPreference = 'Stop'
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$selection = Get-Content -LiteralPath (Join-Path $raw 'build-selection.json') -Raw | ConvertFrom-Json
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $selection.sourceHead -cne $head) { throw 'Continuation controls head differs from selected build' }
$binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
$fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ne $selection.fixtureSha256) { throw 'Continuation controls inputs changed after build' }
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash

# Closed finite groups only. Manual FullSD cases use the existing token and
# explicit --ignored --exact; no privilege adjustment, skip, retry or fallback.
# Synthetic topology/raw-GUID checks are not native capture/restore success.
$groups = @(
  @{ name = 'mixed-codec'; filter = 'file_access::material_mixed_tree_records::tests::'; expected = 6; exact = $false; manual = $false; category = 'portableCodec'; names = @(
    'file_access::material_mixed_tree_records::tests::complete_mixed_actual_typed_bytes_keep_directory_parent_and_raw_regular_extent',
    'file_access::material_mixed_tree_records::tests::old_skeleton_header_and_regular_rejection_do_not_become_mixed_success',
    'file_access::material_mixed_tree_records::tests::regular_root_or_parent_never_grants_child_authority',
    'file_access::material_mixed_tree_records::tests::duplicate_full_ids_alias_and_unknown_tags_stay_refused',
    'file_access::material_mixed_tree_records::tests::typed_kind_mismatch_forward_parent_and_case_insensitive_siblings_are_failures',
    'file_access::material_mixed_tree_records::tests::truncated_corrupt_suffix_cancel_and_shared_budget_never_form_complete_input'
  ) },
  @{ name = 'mixed-owned-purpose'; filter = 'worktrees::material_owner::mixed_tree_tests::ordinary_purpose_is_not_upgraded_to_full_mixed_input'; expected = 1; exact = $true; manual = $false; category = 'ownedPurposeRefusalNotFullSecuritySuccess'; names = @(
    'worktrees::material_owner::mixed_tree_tests::ordinary_purpose_is_not_upgraded_to_full_mixed_input'
  ) },
  @{ name = 'alias-unit'; filter = 'file_access::windows::material_alias_topology::tests::'; expected = 3; exact = $false; manual = $false; category = 'windowsSyntheticTopology'; names = @(
    'file_access::windows::material_alias_topology::tests::full128_identity_not_equal_low64_decides_group_membership',
    'file_access::windows::material_alias_topology::tests::observed_name_count_must_equal_reported_count_for_every_group',
    'file_access::windows::material_alias_topology::tests::conflicting_actual_counts_zero_and_overbound_indices_never_mint_closed_group'
  ) },
  @{ name = 'alias-owned'; filter = 'worktrees::material_owner::alias_topology_tests::'; expected = 6; exact = $false; manual = $false; category = 'ownedAliasTopology'; names = @(
    'worktrees::material_owner::alias_topology_tests::actual_cross_parent_raw_names_form_one_closed_full_identity_group',
    'worktrees::material_owner::alias_topology_tests::actual_outside_alias_is_incomplete_even_with_two_visible_alias_names',
    'worktrees::material_owner::alias_topology_tests::single_visible_name_is_not_complete_when_another_link_is_outside_root',
    'worktrees::material_owner::alias_topology_tests::equal_contents_do_not_merge_distinct_file_objects',
    'worktrees::material_owner::alias_topology_tests::metadata_change_after_readonly_consumer_must_fail_the_same_source_witness',
    'worktrees::material_owner::alias_topology_tests::cancel_and_shared_work_limit_reject_without_calling_the_structural_consumer'
  ) },
  @{ name = 'git-plain'; filter = 'worktrees::windows_git::paths::plain_tests::'; expected = 4; exact = $false; manual = $false; category = 'ownedGitReadContext'; names = @(
    'worktrees::windows_git::paths::plain_tests::real_read_context_command_roles_are_strict_plain_and_same_held_full_objects',
    'worktrees::windows_git::paths::plain_tests::a_configured_worktree_is_rejected_by_the_real_read_context_instead_of_becoming_absent',
    'worktrees::windows_git::paths::plain_tests::a_real_bare_configuration_is_rejected_instead_of_becoming_absent',
    'worktrees::windows_git::paths::plain_tests::alternate_or_normalized_pin_spellings_cannot_mint_a_plain_path_authority'
  ) },
  @{ name = 'raw-guid-synthetic'; filter = 'file_access::windows::material_pin::tests::raw_guid_parent_edge_compares_all_units_and_volume_without_utf8_or_prefix_alias'; expected = 1; exact = $true; manual = $false; category = 'windowsSyntheticRawGuidComparison'; names = @(
    'file_access::windows::material_pin::tests::raw_guid_parent_edge_compares_all_units_and_volume_without_utf8_or_prefix_alias'
  ) },
  @{ name = 'raw-guid-owned-pool'; filter = 'file_access::windows::material_pin::tests::actual_material_raw_guid_buffer_reserves_and_releases_the_same_shared_pool'; expected = 1; exact = $true; manual = $false; category = 'ownedRawGuidLogicalPool'; names = @(
    'file_access::windows::material_pin::tests::actual_material_raw_guid_buffer_reserves_and_releases_the_same_shared_pool'
  ) },
  @{ name = 'raw-guid-owned-directory'; filter = 'worktrees::material_owner::directory_tree_tests::actual_raw_directory_guid_low_surrogate_and_255_unit_edges_keep_ea_ads_and_string_boundary'; expected = 1; exact = $true; manual = $false; category = 'ownedRawGuidDirectory'; names = @(
    'worktrees::material_owner::directory_tree_tests::actual_raw_directory_guid_low_surrogate_and_255_unit_edges_keep_ea_ads_and_string_boundary'
  ) },
  @{ name = 'owned-link-sharing-1'; filter = 'worktrees::material_owner::owned_link_tests::original_primary_blocks_new_delete_opens_before_and_after_verified_link'; expected = 1; exact = $true; manual = $false; category = 'ownedNtfsSharingAndExactCleanup'; names = @(
    'worktrees::material_owner::owned_link_tests::original_primary_blocks_new_delete_opens_before_and_after_verified_link'
  ) },
  @{ name = 'owned-link-sharing-2'; filter = 'worktrees::material_owner::owned_link_tests::verified_alias_followed_by_caller_error_still_closes_the_exact_owner'; expected = 1; exact = $true; manual = $false; category = 'ownedNtfsSharingAndExactCleanup'; names = @(
    'worktrees::material_owner::owned_link_tests::verified_alias_followed_by_caller_error_still_closes_the_exact_owner'
  ) },
  @{ name = 'mixed-fullsd-1'; filter = 'worktrees::material_owner::mixed_tree_tests::actual_mixed_carrier_retains_every_ffdir_and_ffnode_across_complete_callback'; expected = 1; exact = $true; manual = $true; category = 'explicitCurrentTokenFullSecurityNoFallback'; names = @(
    'worktrees::material_owner::mixed_tree_tests::actual_mixed_carrier_retains_every_ffdir_and_ffnode_across_complete_callback'
  ) },
  @{ name = 'mixed-fullsd-2'; filter = 'worktrees::material_owner::mixed_tree_tests::real_inside_and_outside_links_are_not_cloned_as_independent_regular_material'; expected = 1; exact = $true; manual = $true; category = 'explicitCurrentTokenFullSecurityNoFallback'; names = @(
    'worktrees::material_owner::mixed_tree_tests::real_inside_and_outside_links_are_not_cloned_as_independent_regular_material'
  ) },
  @{ name = 'mixed-fullsd-3'; filter = 'worktrees::material_owner::mixed_tree_tests::original_source_witness_must_reject_actual_change_after_consumer_before_cleanup'; expected = 1; exact = $true; manual = $true; category = 'explicitCurrentTokenFullSecurityNoFallback'; names = @(
    'worktrees::material_owner::mixed_tree_tests::original_source_witness_must_reject_actual_change_after_consumer_before_cleanup'
  ) },
  @{ name = 'mixed-fullsd-4'; filter = 'worktrees::material_owner::mixed_tree_tests::cancellation_and_exhausted_shared_work_never_invoke_a_mixed_consumer'; expected = 1; exact = $true; manual = $true; category = 'explicitCurrentTokenFullSecurityNoFallback'; names = @(
    'worktrees::material_owner::mixed_tree_tests::cancellation_and_exhausted_shared_work_never_invoke_a_mixed_consumer'
  ) },
  @{ name = 'mixed-fullsd-5'; filter = 'worktrees::material_owner::mixed_tree_tests::actual_consumer_error_and_unwind_preserve_failure_with_original_slot_cleanup'; expected = 1; exact = $true; manual = $true; category = 'explicitCurrentTokenFullSecurityNoFallback'; names = @(
    'worktrees::material_owner::mixed_tree_tests::actual_consumer_error_and_unwind_preserve_failure_with_original_slot_cleanup'
  ) }
)
$plannedOrdinary = 0
$plannedManual = 0
$plannedNames = @()
foreach ($group in $groups) {
  if ($group.expected -ne @($group.names).Count) { throw 'Continuation group name/count mismatch' }
  if ($group.manual) {
    if (-not $group.exact -or $group.expected -ne 1) { throw 'Manual continuation control must be one exact ignored test' }
    $plannedManual += $group.expected
  } else { $plannedOrdinary += $group.expected }
  $plannedNames += @($group.names)
}
if ($groups.Count -ne 15 -or $plannedOrdinary -ne 25 -or $plannedManual -ne 5 -or @($plannedNames | Select-Object -Unique).Count -ne 30) { throw 'Continuation closed case inventory changed' }
$results = @()
$complete = $true
foreach ($group in $groups) {
  $stdout = Join-Path $raw ('continuation-' + $group.name + '.stdout.log')
  $stderr = Join-Path $raw ('continuation-' + $group.name + '.stderr.log')
  $started = [DateTime]::UtcNow.ToString('o')
  $selectionArguments = @()
  if ($group.manual) { $selectionArguments = @('--ignored', '--exact') }
  elseif ($group.exact) { $selectionArguments = @('--exact') }
  & $binary $group.filter @selectionArguments --nocapture --test-threads=1 1> $stdout 2> $stderr
  $testExit = $LASTEXITCODE
  $finished = [DateTime]::UtcNow.ToString('o')
  $outText = [IO.File]::ReadAllText($stdout)
  $summaries = [regex]::Matches($outText, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
  $last = if ($summaries.Count -eq 1) { $summaries[0] } else { $null }
  $nameMatches = [regex]::Matches($outText, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. ok\r?$')
  $actualNames = @($nameMatches | ForEach-Object { $_.Groups['name'].Value })
  $expectedNames = @($group.names)
  $namesExact = $actualNames.Count -eq $group.expected -and $expectedNames.Count -eq $group.expected -and ((@($actualNames | Sort-Object) -join ',') -ceq (@($expectedNames | Sort-Object) -join ','))
  $passed = $testExit -eq 0 -and $null -ne $last -and $last.Groups['status'].Value -ceq 'ok' -and [int]$last.Groups['passed'].Value -eq $group.expected -and $last.Groups['failed'].Value -eq '0' -and $last.Groups['ignored'].Value -eq '0' -and $namesExact
  if (-not $passed) { $complete = $false }
  $outcomes = @([regex]::Matches($outText, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. (?<outcome>ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$') | ForEach-Object {
    [ordered]@{ name = $_.Groups['name'].Value; outcome = $_.Groups['outcome'].Value }
  })
  $entry = [ordered]@{
    group = $group.name; filter = $group.filter; category = $group.category
    explicitIgnored = $group.manual; exactFilter = $group.exact
    expectedTests = $group.expected; expectedNames = $expectedNames
    actualPassedNames = $actualNames; actualNamedOutcomes = $outcomes
    startedAtUtc = $started; finishedAtUtc = $finished; exitCode = $testExit
    summaryCount = $summaries.Count; finalSummary = if ($last) { $last.Value } else { $null }
    namesExact = $namesExact; exactGroupPassed = $passed
    stdoutSha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash
    stderrSha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash
  }
  $results += $entry
  $entry | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $raw ('continuation-' + $group.name + '.result.json')) -Encoding utf8
  Get-Content -LiteralPath $stdout
  Get-Content -LiteralPath $stderr
}
$finalHead = (& git rev-parse HEAD).Trim()
$headStable = $LASTEXITCODE -eq 0 -and $finalHead -ceq $head
$inputsStable = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -eq $selection.testBinarySha256 -and (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $selection.fixtureSha256 -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -eq $scriptHash
$complete = $complete -and $results.Count -eq 15 -and $headStable -and $inputsStable
[ordered]@{
  schema = 1; head = $head; finalHead = $finalHead; headStable = $headStable
  testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
  runnerScriptSha256 = $scriptHash; inputsStable = $inputsStable
  plannedOrdinaryTests = 25; plannedManualTests = 5; plannedTotalTests = 30
  groupCount = $results.Count; groups = $results; exactAllGroupsPassed = $complete
  carrier149CountChanged = $false; carrier149Acceptance = $false
  separateGitFiveCallAcceptance = $false; originalMatrixEightCellsAcceptance = $false
  privilegesAdjusted = $false; fullSecurityFallbackUsed = $false
  syntheticTopologyAndRawGuidAreNativeCaptureSuccess = $false
  persistentMixedOrAliasRestoreComplete = $false; fullTreeOrManifest2Complete = $false
  productOrAllWindowsComplete = $false
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $raw 'continuation-controls.result.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $raw 'continuation-controls.result.json')
if (-not $complete) { exit 1 }
exit 0
