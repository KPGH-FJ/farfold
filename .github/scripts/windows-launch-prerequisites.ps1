param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead
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
$groups = @(
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
)
$failures = @()
foreach ($group in $groups) {
  Confirm-Inputs
  $testArgs = @($group.filter, '--show-output', '--test-threads=1', '--color=never')
  if ($group.exact) { $testArgs += '--exact' }
  foreach ($name in $group.skip) { $testArgs += @('--skip', $name) }
  $stdout = Join-Path $raw ($group.name + '.stdout.log')
  $stderr = Join-Path $raw ($group.name + '.stderr.log')
  $started = [DateTime]::UtcNow.ToString('o')
  & $binary @testArgs 1> $stdout 2> $stderr
  $exit = [int]$LASTEXITCODE
  $ended = [DateTime]::UtcNow.ToString('o')
  $outText = [IO.File]::ReadAllText($stdout)
  $cases = @([regex]::Matches($outText, '(?m)^test (?<name>\S+) \.\.\. (?<result>ok|FAILED|ignored)\r?$') |
    ForEach-Object { [ordered]@{ name = $_.Groups['name'].Value; result = $_.Groups['result'].Value } })
  $caseNames = @($cases | ForEach-Object { $_.name })
  $exactNames = $caseNames.Count -eq $group.names.Count -and
    @($group.names | Where-Object { $_ -cnotin $caseNames }).Count -eq 0
  $summary = @([regex]::Matches($outText, '(?m)^test result: (ok|FAILED)\. \d+ passed; \d+ failed; \d+ ignored;.*$') |
    ForEach-Object { $_.Value.Trim() })
  $success = $exit -eq 0 -and $exactNames -and $summary.Count -eq 1 -and
    @($cases | Where-Object { $_.result -cne 'ok' }).Count -eq 0
  Confirm-Inputs
  [ordered]@{
    sourceHead = $ExpectedHead
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
