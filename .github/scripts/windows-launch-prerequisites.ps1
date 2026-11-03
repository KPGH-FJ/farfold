param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
  [ValidateSet('LaunchPrerequisites', 'TransportTerminalFile', 'TransportOnly', 'TerminalClose', 'WorktreeRecovery', 'RetirementAndRemove', 'TerminalRetirementFix', 'RemoveRechecks')][string]$Cohort = 'LaunchPrerequisites'
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
      $selection.cohort -cne 'LaunchPrerequisites' -or -not $selection.sourceInputsStable) {
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
}

Confirm-Inputs
$groups = if ($Cohort -ceq 'RemoveRechecks') {
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
$failures = @()
foreach ($group in $groups) {
  Confirm-Inputs
  $threads = $group.threads ?? 1
  $testArgs = @($group.filter, '--show-output', "--test-threads=$threads", '--color=never')
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
  if (-not $success) { $failures += $group.name }
}
if ($failures.Count -gt 0) {
  throw ('Selected checks did not pass: ' + ($failures -join ', '))
}
