param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
  [ValidateSet('LaunchPrerequisites', 'TransportTerminalFile', 'TransportOnly', 'TerminalClose', 'WorktreeRecovery', 'RetirementAndRemove', 'TerminalRetirementFix', 'RemoveRechecks', 'RemoveFixtures', 'RecoveryCancel', 'JobAccounting', 'AccessDiagnostics', 'GitJobWorktree', 'TerminalProbe', 'WorktreeWrapper', 'NativeRetirement', 'CreateEofRecovery', 'CreateEofChallenge', 'GitCompletionRecovery', 'FrozenRetirementResume', 'OpenFailureDiagnostics')][string]$Cohort = 'LaunchPrerequisites',
  [ValidateSet('All', 'Retirement', 'GitControls', 'CreateRecovery', 'CreateTiming', 'CreateUnfinished', 'Terminal', 'Frontend', 'FullRunFailures', 'BoundaryWaits')][string]$Phase = 'All'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$selectionPath = Join-Path $raw 'build-selection.json'
$selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
$sourceMapPath = Join-Path $raw 'inputs-after.json'
$sourceMap = Get-Content -LiteralPath $sourceMapPath -Raw | ConvertFrom-Json -AsHashtable
$workflow = '.github/workflows/windows-launch-prerequisites.yml'
$runner = '.github/scripts/windows-launch-prerequisites.ps1'
$binary = (Resolve-Path -LiteralPath $selection.testBinary).Path
$fixture = (Resolve-Path -LiteralPath $selection.fixture).Path

function Confirm-Inputs {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $selection.sourceHead -cne $ExpectedHead -or
      $selection.cohort -cne 'LaunchPrerequisites' -or $selection.selectedCohort -cne $Cohort -or -not $selection.sourceInputsStable) {
    throw 'Selected Windows source binding changed'
  }
  if ((Get-FileHash -LiteralPath $sourceMapPath -Algorithm SHA256).Hash -cne $selection.inputsAfterSha256 -or
      (Get-FileHash -LiteralPath $workflow -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceMap[$workflow] -or
      (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceMap[$runner]) {
    throw 'Selected Windows workflow or diagnostic runner changed'
  }
  if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -cne $selection.testBinarySha256 -or
      (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -cne $selection.fixtureSha256) {
    throw 'Selected Windows test executable or fixture changed'
  }
  if ($Cohort -ceq 'OpenFailureDiagnostics') {
    foreach ($required in @('src/runtime/ui_error.test.ts', 'src/components/ThreadView.history-recovery.test.tsx', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'index.html')) {
      if (-not $sourceMap.ContainsKey($required)) { throw "Selected frontend input missing: $required" }
    }
    foreach ($path in $sourceMap.Keys) {
      if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceMap[$path]) {
        throw "Selected open-failure source changed: $path"
      }
    }
  }
}

Confirm-Inputs
$allowedPhases = if ($Cohort -ceq 'FrozenRetirementResume') {
  @('Retirement', 'GitControls', 'CreateRecovery', 'CreateTiming', 'CreateUnfinished', 'Terminal', 'FullRunFailures', 'BoundaryWaits')
} elseif ($Cohort -ceq 'OpenFailureDiagnostics') {
  @('All', 'Frontend')
} else { @('All') }
if ($Phase -cnotin $allowedPhases) {
  throw 'Selected cohort does not accept this diagnostic phase'
}
if ($Cohort -ceq 'OpenFailureDiagnostics' -and $Phase -ceq 'Frontend') {
  $testFiles = @('src/runtime/ui_error.test.ts', 'src/components/ThreadView.history-recovery.test.tsx')
  $reportPath = Join-Path $raw 'open-failure-frontend.vitest.json'
  if (Test-Path -LiteralPath $reportPath) { throw 'Selected frontend report already exists' }
  $started = [DateTime]::UtcNow.ToString('o')
  $typecheckExit = $null
  $testExit = $null
  $nodeVersion = $null
  $pnpmVersion = $null
  $actualFiles = @()
  $actualTests = 0
  $exactFiles = $false
  $exactAllPassed = $false
  $sourceInputsStable = $false
  $failure = $null
  $frontendExit = 1
  try {
    $nodeVersion = (& node --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the selected Node version' }
    $pnpmVersion = (& corepack pnpm --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the selected pnpm version' }
    & corepack pnpm typecheck 1> (Join-Path $raw 'open-failure-typecheck.stdout.log') 2> (Join-Path $raw 'open-failure-typecheck.stderr.log')
    $typecheckExit = [int]$LASTEXITCODE
    & corepack pnpm exec vitest run @testFiles --reporter=json "--outputFile=$reportPath" 1> (Join-Path $raw 'open-failure-frontend.stdout.log') 2> (Join-Path $raw 'open-failure-frontend.stderr.log')
    $testExit = [int]$LASTEXITCODE
    $report = Get-Content -LiteralPath $reportPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $files = @($report.testResults)
    $expectedFiles = @($testFiles | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $PWD $_)).Replace('\', '/').ToLowerInvariant() })
    $actualFiles = @($files | ForEach-Object { [IO.Path]::GetFullPath($_.name).Replace('\', '/').ToLowerInvariant() })
    $exactFiles = $actualFiles.Count -eq 2 -and @($expectedFiles | Where-Object { $_ -cnotin $actualFiles }).Count -eq 0
    $cases = @($files | ForEach-Object { $_.assertionResults })
    $actualTests = $cases.Count
    $exactAllPassed = $testExit -eq 0 -and $exactFiles -and $report.success -eq $true -and
      $report.numTotalTests -eq 51 -and $report.numPassedTests -eq 51 -and $report.numFailedTests -eq 0 -and
      $report.numPendingTests -eq 0 -and $report.numTodoTests -eq 0 -and $actualTests -eq 51 -and
      @($files | Where-Object { $_.status -cne 'passed' }).Count -eq 0 -and
      @($cases | Where-Object { $_.status -cne 'passed' }).Count -eq 0
    if ($typecheckExit -ne 0 -or -not $exactAllPassed) { throw 'Selected frontend checks failed or did not execute the exact 2 files and 51 tests' }
    $frontendExit = 0
  } catch {
    $failure = $_.Exception.Message
    Write-Output $failure
  } finally {
    try { Confirm-Inputs; $sourceInputsStable = $true } catch { $failure = $_.Exception.Message; $frontendExit = 1 }
    $rawHashes = [ordered]@{}
    foreach ($name in @('open-failure-typecheck.stdout.log', 'open-failure-typecheck.stderr.log', 'open-failure-frontend.stdout.log', 'open-failure-frontend.stderr.log', 'open-failure-frontend.vitest.json')) {
      $path = Join-Path $raw $name
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        $rawHashes[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($name -cne 'open-failure-frontend.vitest.json') { Get-Content -LiteralPath $path }
      }
    }
    [ordered]@{
      sourceHead = $ExpectedHead; cohort = $Cohort; phase = $Phase
      startedAtUtc = $started; finishedAtUtc = [DateTime]::UtcNow.ToString('o')
      nodeVersion = $nodeVersion; pnpmVersion = $pnpmVersion
      typecheckNaturalExitCode = $typecheckExit; testNaturalExitCode = $testExit
      expectedFiles = $testFiles; actualFiles = $actualFiles; expectedTests = 51; actualTests = $actualTests
      exactFiles = $exactFiles; exactAllPassed = $exactAllPassed
      allReturned = $null -ne $typecheckExit -and $null -ne $testExit
      sourceInputsStable = $sourceInputsStable; failure = $failure; runnerExitCode = $frontendExit
      selectionSha256 = (Get-FileHash -LiteralPath $selectionPath -Algorithm SHA256).Hash
      inputsAfterSha256 = $selection.inputsAfterSha256
      testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
      rawFileSha256 = $rawHashes; productOrAllWindowsComplete = $false
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $raw 'open-failure-Frontend.result.json') -Encoding utf8
  }
  exit $frontendExit
}
$groups = if ($Cohort -ceq 'OpenFailureDiagnostics') {
  $wait = 'acp_client::wait::tests::'
  @{
    name = 'open-wait-replies'; filter = $wait; exact = $false
    names = @(
      "${wait}typed_reply_classifies_only_outer_oneshot_failures",
      "${wait}replies_yield_and_distinguish_timeout_from_closed"
    )
  }
  $reply = 'acp_client::session::open_reply_tests::'
  @{
    name = 'open-reply-diagnostics'; filter = $reply; exact = $false
    names = @(
      "${reply}open_reply_timeout_is_fixed_and_late_receipt_returns_to_sender",
      "${reply}open_reply_closed_is_fixed_without_a_remote_error",
      "${reply}open_reply_keeps_delayed_success_and_inner_manager_errors"
    )
  }
  $delivery = 'acp_client::lifecycle_tests::open_delivery_tests::'
  @{
    name = 'open-delivery-ownership'; filter = $delivery; exact = $false
    names = @(
      "${delivery}open_delivery_success_releases_both_reservations_before_actual_reply",
      "${delivery}open_delivery_failure_releases_both_reservations_before_actual_reply",
      "${delivery}open_delivery_receiver_drops_during_notification_retains_identity_until_reaping",
      "${delivery}open_delivery_buffered_success_is_owned_until_consumed_or_dropped",
      "${delivery}open_delivery_timeout_keeps_native_reservation_until_actual_process_reaping",
      "${delivery}open_delivery_abandoned_caller_keeps_native_reservation_until_actual_process_reaping",
      "${delivery}open_delivery_unstarted_expired_or_closed_queue_never_sends_load",
      "${delivery}cold_admission_unconsumed_delivery_holds_slot_until_real_reap",
      "${delivery}cold_admission_timeout_holds_slot_until_real_reap"
    )
  }
  $test = 'acp_client::operations::open_result::tests::open_delivery_closing_retains_reservation_until_process_completion'
  @{ name = 'open-result-reservation'; filter = $test; exact = $true; names = @($test) }
  $fork = 'acp_client::session_fork::owner_tests::'
  @{
    name = 'fork-owner-preservation'; filter = $fork; exact = $false
    names = @(
      "${fork}fork_observer_keeps_open_identity_after_all_delivery_and_pump_owners_drop",
      "${fork}fork_observer_retires_on_whole_operation_finish_while_parent_stays_live",
      "${fork}fork_observer_source_release_does_not_end_pending_destination_after_parent_reap"
    )
  }
} elseif ($Cohort -ceq 'RemoveFixtures') {
  $test = 'worktrees::recovery_tests::recovery_content_has_no_inode_identity_but_preserves_empty_material'
  @{ name = 'recovery-material-identity'; filter = $test; exact = $true; names = @($test) }
  $test = 'worktrees::manager::remove_recheck_tests::removal_recheck_rejects_changed_proof_identity_or_older_revision_before_verification'
  @{ name = 'worktree-remove-identity-recheck'; filter = $test; exact = $true; names = @($test) }
} elseif ($Cohort -cin @('JobAccounting', 'AccessDiagnostics')) {
  if ($Cohort -ceq 'JobAccounting') {
    $test = 'windows_process::current_members::tests::native_job_accounting_samples_exact_children_across_exit_and_handle_release'
    @{ name = 'job-accounting-exact-handles'; filter = $test; exact = $true; names = @($test) }
    $test = 'windows_process::current_members::tests::unknown_accounting_with_failed_snapshot_keeps_gap_after_a_later_empty_list'
    @{ name = 'job-accounting-sticky-gap'; filter = $test; exact = $true; names = @($test) }
    $test = 'pty::windows_tests::terminal_cancel_after_native_spawn_before_publication_isolated'
    @{ name = 'terminal-cancel-before-publication'; filter = $test; exact = $true; names = @($test); ignored = $true }
  }
  $startup = 'acp_client::process::startup_tests::'
  $tests = [ordered]@{
    'startup-parent-error' = "${startup}spawn_failure_missing_program_records_os_error_and_own_file_limits"
    'startup-cancel-precedence' = "${startup}startup_diagnostics_cancel_selected_after_spawn_failure_keeps_cancelled_outcome"
    'startup-selected-helper-error' = "${startup}missing_selected_program_is_reported_by_the_owned_windows_helper"
    'history-selected-read' = 'acp_client::history_search::tests::admission_tests::reviewed_codex_history_uses_fixed_read_pages_and_preserves_source_offsets'
    'history-wrong-source' = 'acp_client::history_search::tests::admission_tests::reviewed_codex_history_rejects_wrong_native_id_and_different_cwd'
  }
  foreach ($test in $tests.GetEnumerator()) {
    @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
  }
} elseif ($Cohort -cin @('CreateEofRecovery', 'CreateEofChallenge', 'GitCompletionRecovery', 'FrozenRetirementResume')) {
  if ($Cohort -ceq 'FrozenRetirementResume') {
    # Run the four frozen candidate regressions first, without changing their
    # assertions or reopening the separate historical-gap challenge cohort.
    $lifetime = 'windows_process::current_members::tests::lifetime_tests::'
    $tests = [ordered]@{
      'lifetime-complete-retirement' = "${lifetime}complete_live_objects_retire_original_job_without_clearing_historical_gap"
      'lifetime-missing-object-refused' = "${lifetime}reopening_signaled_objects_never_compensates_for_an_unobserved_original_member"
      'lifetime-leader-context-refused' = "${lifetime}missing_or_changed_leader_context_permanently_refuses_lifetime_proof"
      'lifetime-count-overflow-refused' = "${lifetime}checked_live_count_overflow_cannot_supply_lifetime_coverage"
    }
    foreach ($test in $tests.GetEnumerator()) {
      @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
    }
    $terminal = 'platform_tests::windows_conpty::'
    $tests = [ordered]@{
      'terminal-manager-python' = "${terminal}actual_manager_with_valid_windows_python_is_bounded"
      'terminal-manager-no-reply-close' = "${terminal}manager_cursor_no_reply_control_records_readiness_and_confirms_cleanup"
      'terminal-raw-cursor-reply' = "${terminal}raw_conpty_replies_only_to_an_observed_query"
    }
    foreach ($test in $tests.GetEnumerator()) {
      @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
    }
  }
  if ($Cohort -ceq 'CreateEofChallenge') {
    $test = 'windows_process::current_members::tests::gap_shadow_tests::native_zero_empty_window_never_precedes_untracked_exact_target_signal'
    @{ name = 'job-gap-shadow-challenge'; filter = $test; exact = $true; names = @($test); ignored = $true }
  }
  $tests = [ordered]@{
    'create-existing-branch' = 'worktrees::tests::existing_branch_and_checkout_transforms_modes_links_are_preserved'
    'acp-eof-retirement' = 'acp_client::active_prompt_tests::real_stdio_eof_is_not_a_terminal_but_actual_reap_releases'
    'archive-cold-restore' = 'worktrees::recycle::windows_tests::public_ordinary_archive_cold_restore_preserves_owned_objects_and_readable_metadata'
  }
  foreach ($test in $tests.GetEnumerator()) {
    @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
  }
  $prefix = 'worktrees::recover_tests::recover_cancel'
  @{
    name = 'recovery-cancel-paired'; filter = $prefix; exact = $false; threads = 2
    names = @(
      'worktrees::recover_tests::recover_cancel_during_validation_has_exact_action_and_keeps_worker_admission',
      'worktrees::recover_tests::recover_cancelled_prepare_never_creates_and_existing_destination_is_preserved'
    )
  }
  if ($Cohort -cin @('CreateEofChallenge', 'GitCompletionRecovery', 'FrozenRetirementResume')) {
    $parallel = @(
      'worktrees::tests::existing_branch_and_checkout_transforms_modes_links_are_preserved',
      'acp_client::active_prompt_tests::real_stdio_eof_is_not_a_terminal_but_actual_reap_releases'
    )
    @{ name = 'create-eof-paired'; filter = $parallel; exact = $false; threads = 2; names = $parallel }
  }
  $archivePair = @(
    'worktrees::recycle::windows_tests::public_ordinary_archive_cold_restore_preserves_owned_objects_and_readable_metadata',
    'worktrees::tests::existing_branch_and_checkout_transforms_modes_links_are_preserved'
  )
  @{ name = 'archive-create-paired'; filter = $archivePair; exact = $false; threads = 2; names = $archivePair }
  if ($Cohort -cin @('GitCompletionRecovery', 'FrozenRetirementResume')) {
    $test = 'windows_process::debug_certificate::tests::certificate_requires_every_distinct_original_object_signal'
    @{ name = 'git-complete-object-certificate'; filter = $test; exact = $true; names = @($test) }
    $test = 'acp_client::active_prompt_tests::eof_descendant_tests::actual_eof_descendant_exit_edge_isolated'
    @{ name = 'acp-eof-descendant-edge'; filter = $test; exact = $true; names = @($test); ignored = $true }
    $settlement = 'worktrees::git::settlement_tests::'
    @{
      name = 'git-original-owner-lifecycle'; filter = $settlement; exact = $false; threads = 2
      names = @(
        "${settlement}original_exit_waits_for_same_job_natural_end_and_collects_descendant_tail",
        "${settlement}naturally_settled_job_preserves_original_nonzero_exit_code",
        "${settlement}cancellation_after_original_exit_reaps_same_job_before_return",
        "${settlement}original_deadline_still_limits_live_job_after_original_exit",
        "${settlement}late_stdout_over_limit_after_original_exit_is_not_success",
        "${settlement}late_stderr_over_limit_after_original_exit_is_not_success",
        "${settlement}changed_finite_input_after_original_exit_is_not_success",
        "${settlement}unwind_after_original_exit_pumps_debug_events_until_exact_descendant_signal"
      )
    }
    $inputs = 'worktrees::git::input::tests::'
    @{
      name = 'git-finite-input'; filter = $inputs; exact = $false; threads = 2
      names = @(
        "${inputs}real_runner_delivers_opaque_finite_bytes_and_true_eof_after_platform_command_rebuild",
        "${inputs}explicit_null_replaces_preconfigured_stdin_while_generic_platform_behavior_is_preserved",
        "${inputs}selected_held_file_range_is_snapshotted_from_its_current_offset_without_prefix_or_later_edits",
        "${inputs}factory_caps_cancel_and_invalid_offset_refuse_without_exposing_payload_in_errors",
        "${inputs}empty_finite_file_is_valid_and_not_a_failed_or_truncated_input",
        "${inputs}cancellation_before_spawn_and_staged_size_drift_cannot_dispatch_the_selected_peer",
        "${inputs}common_file_output_path_retains_exact_input_and_original_output_limit_cleanup"
      )
    }
    $recoverRemaining = @(
      'worktrees::recover_tests::recover_explicit_new_folder_is_independent_existing_and_cold_never_restarts',
      'worktrees::recover_tests::recover_keeps_private_ref_and_orphan_reflog_only_commits_offline'
    )
    @{ name = 'recovery-original-remaining'; filter = $recoverRemaining; exact = $false; threads = 2; names = $recoverRemaining }
    $confirmation = 'worktrees::remove_boundary_tests::remove_confirmation_'
    @{
      name = 'recovery-confirmation'; filter = $confirmation; exact = $false; threads = 2
      names = @(
        "${confirmation}rechecks_reflog_evidence_even_same_root_set",
        "${confirmation}rejects_corrupt_bundle_and_keeps_source"
      )
    }
    $cold = 'worktrees::remove_boundary_tests::remove_cold_'
    @{
      name = 'recovery-cold'; filter = $cold; exact = $false; threads = 2
      names = @(
        "${cold}contract_rejects_misaligned_recovery_and_duplicate_ids",
        "${cold}dispatched_record_survives_next_intent_and_reconciles_exact_absence"
      )
    }
    $remainingOriginal = [ordered]@{
      'create-official-config-aliases' = 'worktrees::config_compatibility_tests::official_boolean_aliases_preserve_checkout_and_do_not_reject_an_ordinary_repository'
      'create-cold-location' = 'worktrees::manager::tests::cold_old_location_and_material_ids_cannot_start_new_filesystem_work'
      'create-storage-failure' = 'worktrees::manager::tests::real_git_completion_followed_by_storage_failure_keeps_files_and_can_recover_metadata_only'
      'create-new-branch' = 'worktrees::tests::creates_exact_new_branch_preserves_original_index_dirty_ignored_and_disables_hook'
    }
    foreach ($test in $remainingOriginal.GetEnumerator()) {
      @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
    }
    $recoverySingles = [ordered]@{
      'recovery-prepared-cancel' = 'worktrees::recovery_tests::recovery_cancel_prepared_keeps_verified_artifact_and_no_delete_authority'
      'recovery-parent-identity' = 'worktrees::remove_boundary_tests::removal_identity_recovered_repository_rejects_replaced_parent'
    }
    foreach ($test in $recoverySingles.GetEnumerator()) {
      @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
    }
  }
} elseif ($Cohort -ceq 'NativeRetirement') {
  $conpty = 'platform_tests::windows_conpty::'
  $gitJob = 'windows_process::current_members::tests::git_exact_handle_tests::'
  $tests = [ordered]@{
    'conpty-no-reply-drain' = @{ name = "${conpty}raw_conpty_draining_without_cursor_reply_is_bounded" }
    'conpty-reply-after-job-end' = @{ name = "${conpty}raw_conpty_reply_after_job_end_unblocks_retirement"; ignored = $true }
    'git-exact-handle-control' = @{ name = "${gitJob}actual_git_job_observes_exact_launch_handle_across_exit" }
    'git-debugger-descendants' = @{ name = "${gitJob}actual_git_job_debugger_observes_transient_descendant_handles" }
  }
  foreach ($test in $tests.GetEnumerator()) {
    $case = $test.Value
    @{ name = $test.Key; filter = $case.name; exact = $true; names = @($case.name); ignored = $case.ignored }
  }
} elseif ($Cohort -ceq 'WorktreeWrapper') {
  $tests = @(
    'worktrees::remove_boundary_tests::removal_identity_deleted_requires_original_retained_parent',
    'worktrees::remove_wire_tests::actual_remove_and_recover_wire_receipts'
  )
  @{ name = 'worktree-removal-wrappers'; filter = $tests; exact = $false; threads = 2; names = $tests }
} elseif ($Cohort -ceq 'TerminalProbe') {
  $prefix = 'platform_tests::windows_conpty::'
  $tests = [ordered]@{
    'terminal-manager-python' = "${prefix}actual_manager_with_valid_windows_python_is_bounded"
    'terminal-manager-no-reply-close' = "${prefix}manager_cursor_no_reply_control_records_readiness_and_confirms_cleanup"
    'terminal-raw-cursor-reply' = "${prefix}raw_conpty_replies_only_to_an_observed_query"
  }
  foreach ($test in $tests.GetEnumerator()) {
    @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
  }
} elseif ($Cohort -ceq 'GitJobWorktree') {
  $tests = [ordered]@{
    'git-job-exact-handle' = 'windows_process::current_members::tests::git_exact_handle_tests::actual_git_job_observes_exact_launch_handle_across_exit'
    'maintenance-failed-unseal' = 'meta_store::worktree_maintenance::tests::completed_maintenance_with_failed_unseal_returns_unknown_and_allows_confirmed_exit'
    'worktree-removal-parent-identity' = 'worktrees::remove_boundary_tests::removal_identity_deleted_requires_original_retained_parent'
    'worktree-remove-recover-wire' = 'worktrees::remove_wire_tests::actual_remove_and_recover_wire_receipts'
    'worktree-remove-offline-two-confirmations' = 'worktrees::recovery_tests::recovery_two_confirmations_preserve_branch_and_restore_without_source_objects'
  }
  foreach ($test in $tests.GetEnumerator()) {
    @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
  }
} elseif ($Cohort -ceq 'RemoveRechecks') {
  $prefix = 'worktrees::manager::remove_recheck_tests::'
  @{
    name = 'worktree-remove-rechecks'; filter = $prefix; exact = $false; threads = 2
    names = @(
      "${prefix}warm_remove_recheck_can_recover_through_the_manager",
      "${prefix}cold_remove_recheck_can_recover_through_the_manager",
      "${prefix}removal_recheck_uses_newer_canonical_revision_without_accepting_stale_recovery_input",
      "${prefix}removal_recheck_never_promotes_tampered_bundle_or_manifest",
      "${prefix}removal_recheck_rejects_changed_proof_identity_or_older_revision_before_verification",
      "${prefix}late_removal_verification_cannot_overwrite_newer_catalogue_or_another_operation"
    )
  }
  $test = 'worktrees::recovery_tests::recovery_content_has_no_inode_identity_but_preserves_empty_material'
  @{ name = 'recovery-material-identity'; filter = $test; exact = $true; names = @($test) }
  $test = 'worktrees::recovery_tests::recovery_refuses_assume_unchanged_bytes_and_ignored_empty_directories'
  @{ name = 'worktree-recovery-refusal'; filter = $test; exact = $true; names = @($test) }
} elseif ($Cohort -ceq 'RecoveryCancel') {
  $tests = [ordered]@{
    'worktree-recover-cold' = 'worktrees::recover_tests::recover_explicit_new_folder_is_independent_existing_and_cold_never_restarts'
    'worktree-recovery-refusal' = 'worktrees::recovery_tests::recovery_refuses_assume_unchanged_bytes_and_ignored_empty_directories'
    'mcp-add-cancel' = 'acp_client::skill_management::mcp_add_tests::mcp_add_cancel_after_write_retains_real_cleanup_and_shared_slot'
    'mcp-http-cancel' = 'acp_client::skill_management::mcp_http_lifecycle_tests::mcp_http_cancel_after_write_keeps_real_worker_scope_and_budget_until_reaped'
    'mcp-remove-cancel' = 'acp_client::skill_management::mcp_remove_tests::mcp_remove_cancel_after_write_retains_real_cleanup_and_shared_slot'
  }
  foreach ($test in $tests.GetEnumerator()) {
    @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
  }
} elseif ($Cohort -ceq 'RetirementAndRemove') {
  $test = 'platform_tests::windows_conpty::raw_conpty_reply_after_job_end_unblocks_retirement'
  @{ name = 'terminal-retirement-reply'; filter = $test; exact = $true; names = @($test); ignored = $true }
  $test = 'worktrees::manager::remove_recheck_tests::cold_remove_recheck_can_recover_through_the_manager'
  @{ name = 'worktree-cold-remove-recheck'; filter = $test; exact = $true; names = @($test) }
} elseif ($Cohort -ceq 'WorktreeRecovery') {
  $public = 'worktrees::recovery_ordinary_windows_tests::ordinary_public_'
  @{
    name = 'worktree-public-recovery'; filter = $public; exact = $false; threads = 2
    names = @(
      "${public}backup_cold_recover_keeps_original_and_rechecks",
      "${public}confirm_delete_then_offline_cold_recover_preserves_all_material"
    )
  }
  $test = 'worktrees::manager::remove_recheck_tests::cold_remove_recheck_can_recover_through_the_manager'
  @{ name = 'worktree-cold-remove-recheck'; filter = $test; exact = $true; names = @($test) }
} elseif ($Cohort -cin @('TerminalClose', 'TerminalRetirementFix')) {
  $terminal = 'pty::windows_tests::'
  $replies = if ($Cohort -ceq 'TerminalClose') { @('reply', 'no_reply') } else { @('reply') }
  foreach ($reply in $replies) {
    $test = "${terminal}terminal_cancel_cursor_${reply}_isolated"
    @{ name = "terminal-close-$reply"; filter = $test; exact = $true; names = @($test); ignored = $true }
  }
  $test = "${terminal}cancelling_a_windows_terminal_confirms_job_end_without_an_agent_isolated"
  @{ name = 'terminal-close-original'; filter = $test; exact = $true; names = @($test) }
  $test = 'auth::terminal::tests::windows_cancellation_after_spawn_keeps_the_original_exit_owner_isolated'
  @{ name = 'terminal-auth-cancel'; filter = $test; exact = $true; names = @($test) }
  if ($Cohort -ceq 'TerminalClose') {
    $test = 'platform_tests::windows_conpty::raw_conpty_input_eof_before_close_without_cursor_reply'
    @{ name = 'terminal-input-eof'; filter = $test; exact = $true; names = @($test); ignored = $true }
  } else {
    $test = "${terminal}terminal_close_confirms_exit_with_unanswered_startup_cursor"
    @{ name = 'terminal-pending-cursor-close'; filter = $test; exact = $true; names = @($test); ignored = $true }
  }
} elseif ($Cohort -cne 'LaunchPrerequisites') {
  $transport = 'acp_client::event_transport_baseline_tests::real_stdio_tauri_callback_backlog_preserves_unknowns_and_'
  $terminal = 'platform_tests::windows_conpty::'
  $cases = [ordered]@{
    'transport-approval' = "${transport}approval"
    'transport-stop' = "${transport}stop"
    'terminal-manager' = "${terminal}actual_manager_with_valid_windows_python_is_bounded"
    'terminal-drain' = "${terminal}raw_conpty_draining_without_cursor_reply_is_bounded"
    'terminal-no-reply' = "${terminal}manager_cursor_no_reply_control_records_readiness_and_confirms_cleanup"
    'terminal-reply' = "${terminal}manager_cursor_reply_control_reaches_ready_and_confirms_cleanup"
    'file-root-replacement' = 'file_delivery::tests::replaced_root_during_read_is_rejected'
  }
  foreach ($case in $cases.GetEnumerator()) {
    if ($Cohort -ceq 'TransportOnly' -and $case.Key -cnotlike 'transport-*') { continue }
    @{ name = $case.Key; filter = $case.Value; exact = $true; names = @($case.Value); threads = 1 }
  }
  @{
    name = 'transport-concurrent'
    filter = $transport
    exact = $false
    names = @($cases['transport-approval'], $cases['transport-stop'])
    threads = 2
  }
} else { @(
  @{
    name = 'initial-connect'
    filter = 'acp_client::session::prompt_context_tests::'
    exact = $false
    skip = @(
      'acp_client::session::prompt_context_tests::audio_tests::prompt_audio_does_not_change_non_audio_admission',
      'acp_client::session::prompt_context_tests::prompt_context_gate_requires_typed_true_only_for_resource_variant'
    )
    names = @(
      'acp_client::session::prompt_context_tests::audio_tests::prompt_audio_actual_supported_wire_preserves_original_bytes_and_busy_guard',
      'acp_client::session::prompt_context_tests::audio_tests::prompt_audio_exact_whole_file_limit_sends_and_two_extra_bytes_never_reach_control',
      'acp_client::session::prompt_context_tests::audio_tests::prompt_audio_false_missing_and_malformed_reject_despite_preparation_and_cache',
      'acp_client::session::prompt_context_tests::audio_tests::prompt_audio_missing_actual_handshake_rejects_without_sending',
      'acp_client::session::prompt_context_tests::audio_tests::prompt_audio_total_and_invalid_payload_reject_before_control_without_fallback',
      'acp_client::session::prompt_context_tests::prompt_context_baseline_text_and_link_need_no_embedded_handshake',
      'acp_client::session::prompt_context_tests::prompt_context_false_or_omitted_actual_session_rejects_despite_supported_preparation_and_cache',
      'acp_client::session::prompt_context_tests::prompt_context_missing_actual_handshake_rejects_before_control_send',
      'acp_client::session::prompt_context_tests::prompt_context_supported_actual_wire_preserves_content_and_pump_busy_guard',
      'acp_client::session::prompt_context_tests::prompt_context_supported_does_not_bypass_existing_preview_protection'
    )
  },
  @{
    name = 'create'
    filter = 'worktrees::tests::creates_exact_new_branch_preserves_original_index_dirty_ignored_and_disables_hook'
    exact = $true
    names = @('worktrees::tests::creates_exact_new_branch_preserves_original_index_dirty_ignored_and_disables_hook')
  },
  @{
    name = 'create-launch-control'
    filter = 'worktrees::windows_git::launch_matrix_tests::owned_same_program_known_config_extended_plain_observations_preserve_original_owner'
    exact = $true
    names = @('worktrees::windows_git::launch_matrix_tests::owned_same_program_known_config_extended_plain_observations_preserve_original_owner')
  }
) }
if ($Cohort -ceq 'FrozenRetirementResume') {
  $retirementGroups = @('lifetime-complete-retirement', 'lifetime-missing-object-refused', 'lifetime-leader-context-refused', 'lifetime-count-overflow-refused', 'acp-eof-retirement', 'acp-eof-descendant-edge')
  $gitGroups = @('git-complete-object-certificate', 'git-original-owner-lifecycle', 'git-finite-input')
  $terminalGroups = @('terminal-manager-python', 'terminal-manager-no-reply-close', 'terminal-raw-cursor-reply')
  $groupNames = @($groups | ForEach-Object { $_.name })
  $plannedExecutions = @($groups | ForEach-Object { $_.names.Count } | Measure-Object -Sum).Sum
  if ($groups.Count -ne 26 -or @($groupNames | Select-Object -Unique).Count -ne 26 -or $plannedExecutions -ne 45) {
    throw 'Resumed frozen candidate inventory changed'
  }
  $selectedGroupNames = switch ($Phase) {
    'Retirement' { $retirementGroups }
    'GitControls' { $gitGroups }
    'Terminal' { $terminalGroups }
    'CreateTiming' { 'create-existing-branch' }
    'CreateUnfinished' { 'create-official-config-aliases', 'create-cold-location', 'create-storage-failure', 'create-new-branch' }
    'CreateRecovery' { $groupNames | Where-Object { $_ -cnotin ($retirementGroups + $gitGroups + $terminalGroups) } }
  }
  $groups = @($groups | Where-Object { $_.name -cin $selectedGroupNames })
  if ($Phase -ceq 'CreateUnfinished') {
    # Only the nine actual failures from41818072244. The other original tests
    # keep their existing cohort selection; no passing sibling is added here.
    $remainingTests = [ordered]@{
      'recovery-orphan-roots' = 'worktrees::recover_tests::recover_keeps_private_ref_and_orphan_reflog_only_commits_offline'
      'recovery-confirmation-reflog' = 'worktrees::remove_boundary_tests::remove_confirmation_rechecks_reflog_evidence_even_same_root_set'
      'recovery-confirmation-corrupt' = 'worktrees::remove_boundary_tests::remove_confirmation_rejects_corrupt_bundle_and_keeps_source'
      'recovery-cold-dispatched' = 'worktrees::remove_boundary_tests::remove_cold_dispatched_record_survives_next_intent_and_reconciles_exact_absence'
      'recovery-cold-contract' = 'worktrees::remove_boundary_tests::remove_cold_contract_rejects_misaligned_recovery_and_duplicate_ids'
    }
    $groups += @(foreach ($test in $remainingTests.GetEnumerator()) {
      @{ name = $test.Key; filter = $test.Value; exact = $true; names = @($test.Value) }
    })
  }
  if ($Phase -ceq 'FullRunFailures') {
    # Exactly the five distinct failures observed before full41830692244 was
    # cancelled. Preserve the ordinary cohort and its paired selections.
    $history = 'acp_client::history_search::tests::real_cancel_keeps_worker_scope_and_budget_until_owned_process_exit'
    $recoveries = @(
      'worktrees::recover_tests::recover_explicit_new_folder_is_independent_existing_and_cold_never_restarts',
      'worktrees::recover_tests::recover_keeps_private_ref_and_orphan_reflog_only_commits_offline'
    )
    $parentBudgets = @(
      'worktrees::manager::remove_recheck_tests::removal_recheck_never_promotes_tampered_bundle_or_manifest',
      'worktrees::recovery_ordinary_windows_tests::ordinary_public_confirm_delete_then_offline_cold_recover_preserves_all_material'
    )
    # Worktree --exact invocations are the isolated child entrypoint. Keep the
    # full-suite parent wrapper active, including contention between fixtures.
    $groups = @(
      @{ name = 'history-cancel-pid-publication'; filter = $history; exact = $true; names = @($history) },
      @{ name = 'recovery-running-waits'; filter = $recoveries; exact = $false; threads = 2; names = $recoveries },
      @{ name = 'recovery-parent-budgets'; filter = $parentBudgets; exact = $false; threads = 2; names = $parentBudgets }
    )
  }
  if ($Phase -ceq 'BoundaryWaits') {
    # Exactly the two failures from full41853291008. Keep both isolated parent
    # wrappers active, including contention between their owned repositories.
    $boundaries = @(
      'worktrees::remove_boundary_tests::removal_identity_recovered_repository_rejects_replaced_parent',
      'worktrees::remove_boundary_tests::remove_cancelled_retirement_keeps_maintenance_until_worker_returns'
    )
    $groups = @(
      @{ name = 'removal-boundary-waits'; filter = $boundaries; exact = $false; threads = 2; names = $boundaries }
    )
  }
  $expectedGroups = @{ Retirement = 6; GitControls = 3; CreateRecovery = 14; CreateTiming = 1; CreateUnfinished = 9; Terminal = 3; FullRunFailures = 3; BoundaryWaits = 1 }[$Phase]
  $expectedExecutions = @{ Retirement = 6; GitControls = 16; CreateRecovery = 20; CreateTiming = 1; CreateUnfinished = 9; Terminal = 3; FullRunFailures = 5; BoundaryWaits = 2 }[$Phase]
  if ($groups.Count -ne $expectedGroups -or @($groups | ForEach-Object { $_.names.Count } | Measure-Object -Sum).Sum -ne $expectedExecutions) {
    throw 'Resumed phase selection incomplete'
  }
}
if ($Cohort -ceq 'OpenFailureDiagnostics') {
  $expectedGroups = 5
  $expectedExecutions = 18
  $selectedNames = @($groups | ForEach-Object { $_.names })
  if ($groups.Count -ne $expectedGroups -or $selectedNames.Count -ne $expectedExecutions -or @($selectedNames | Sort-Object -Unique).Count -ne $expectedExecutions) {
    throw 'Selected open-failure native cohort incomplete'
  }
}
$failures = @()
$completedGroups = @()
foreach ($group in $groups) {
  Confirm-Inputs
  $threads = $group.threads ?? 1
  $testArgs = @($group.filter) + @('--show-output', "--test-threads=$threads", '--color=never')
  if ($group.exact) { $testArgs += '--exact' }
  if ($group.ignored) { $testArgs += '--ignored' }
  foreach ($name in $group.skip) { $testArgs += @('--skip', $name) }
  $stdout = Join-Path $raw ($group.name + '.stdout.log')
  $stderr = Join-Path $raw ($group.name + '.stderr.log')
  $started = [DateTime]::UtcNow.ToString('o')
  & $binary @testArgs 1> $stdout 2> $stderr
  $exit = [int]$LASTEXITCODE
  $ended = [DateTime]::UtcNow.ToString('o')
  $outText = [IO.File]::ReadAllText($stdout)
  # Captured child libtest output can contain its own results and summary.
  $resultPrefix = ($outText -split '(?m)^(?:successes|failures):\r?$', 2)[0]
  $cases = @([regex]::Matches($resultPrefix, '(?m)^test (?<name>\S+) \.\.\. (?<result>ok|FAILED|ignored)\r?$') |
    ForEach-Object { [ordered]@{ name = $_.Groups['name'].Value; result = $_.Groups['result'].Value } })
  $caseNames = @($cases | ForEach-Object { $_.name })
  $exactNames = $caseNames.Count -eq $group.names.Count -and
    @($group.names | Where-Object { $_ -cnotin $caseNames }).Count -eq 0
  $summary = @([regex]::Matches($outText, '(?m)^test result: (ok|FAILED)\. \d+ passed; \d+ failed; \d+ ignored;.*$') |
    ForEach-Object { $_.Value.Trim() } | Select-Object -Last 1)
  $success = $exit -eq 0 -and $exactNames -and
    $summary -match "^test result: ok\. $($group.names.Count) passed; 0 failed; 0 ignored;" -and
    @($cases | Where-Object { $_.result -cne 'ok' }).Count -eq 0
  Confirm-Inputs
  [ordered]@{
    sourceHead = $ExpectedHead
    cohort = $Cohort
    phase = $Phase
    selectionSha256 = (Get-FileHash -LiteralPath $selectionPath -Algorithm SHA256).Hash
    testBinarySha256 = $selection.testBinarySha256
    fixtureSha256 = $selection.fixtureSha256
    argv = $testArgs
    expectedNames = $group.names
    actualCases = $cases
    exactNames = $exactNames
    startedAt = $started
    endedAt = $ended
    naturalExitCode = $exit
    summary = $summary
    passed = $success
    stdoutSha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash
    stderrSha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $raw ($group.name + '.json')) -Encoding utf8
  Get-Content -LiteralPath $stdout
  Get-Content -LiteralPath $stderr
  $completedGroups += [ordered]@{ name = $group.name; naturalExitCode = $exit; expectedTests = $group.names.Count; passed = $success }
  if (-not $success) { $failures += $group.name }
}
if ($Cohort -ceq 'FrozenRetirementResume') {
  Confirm-Inputs
  [ordered]@{
    sourceHead = $ExpectedHead; cohort = $Cohort; phase = $Phase
    expectedGroups = $expectedGroups; expectedExecutions = $expectedExecutions
    completedGroups = $completedGroups.Count; groups = $completedGroups
    allReturned = $completedGroups.Count -eq $expectedGroups
    exactAllPassed = $completedGroups.Count -eq $expectedGroups -and $failures.Count -eq 0
    testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
    sourceInputsStable = $true; productOrAllWindowsComplete = $false
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $raw ("resume-$Phase.result.json")) -Encoding utf8
}
if ($Cohort -ceq 'OpenFailureDiagnostics') {
  Confirm-Inputs
  [ordered]@{
    sourceHead = $ExpectedHead; cohort = $Cohort; phase = $Phase
    expectedGroups = $expectedGroups; expectedExecutions = $expectedExecutions
    completedGroups = $completedGroups.Count; groups = $completedGroups
    allReturned = $completedGroups.Count -eq $expectedGroups
    exactAllPassed = $completedGroups.Count -eq $expectedGroups -and $failures.Count -eq 0
    testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
    selectionSha256 = (Get-FileHash -LiteralPath $selectionPath -Algorithm SHA256).Hash
    inputsAfterSha256 = $selection.inputsAfterSha256
    sourceInputsStable = $true; productOrAllWindowsComplete = $false
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $raw 'open-failure-All.result.json') -Encoding utf8
}
if ($failures.Count -gt 0) {
  throw ('Selected checks did not pass: ' + ($failures -join ', '))
}
