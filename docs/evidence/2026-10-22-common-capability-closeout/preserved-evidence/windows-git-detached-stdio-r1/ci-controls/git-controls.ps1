param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedHead,
  [Parameter(Mandatory = $true)]
  [ValidateSet('LaunchContracts', 'GitSettlement')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$selection = Get-Content -LiteralPath (Join-Path $raw 'build-selection.json') -Raw | ConvertFrom-Json -ErrorAction Stop
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $selection.sourceHead -cne $head -or $selection.sourceInputsStable -isnot [bool] -or -not $selection.sourceInputsStable) { throw 'Git control source differs from the stable selected build' }
$binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
$fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
function Inputs {
  # Exactly the build script's source-map scope; this script is included by the
  # existing windows-recovery-followup* pattern after the checkpoint is committed.
  $paths = @(& git ls-files -- 'src-tauri/src' 'src-tauri/native' 'src-tauri/examples' 'src-tauri/Cargo.toml' 'src-tauri/Cargo.lock' 'src-tauri/build.rs' 'src-tauri/*.json' 'src-tauri/*.manifest' '.github/scripts/windows-capability-closeout*' '.github/scripts/windows-recovery-followup*' '.github/scripts/windows-null-attributes-cases.json' '.github/scripts/windows-native-loader-diagnostics.ps1' '.github/workflows/windows-recovery-followup.yml' | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 100) { throw 'Git control source map incomplete' }
  $map = [ordered]@{}
  foreach ($path in $paths) { $map[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  return $map
}
function Same-Inputs($Left, $Right) {
  if ($Left.Count -ne $Right.Count) { return $false }
  foreach ($key in $Left.Keys) {
    if (-not $Right.Contains($key) -or $Left[$key] -isnot [string] -or $Right[$key] -isnot [string] -or $Left[$key] -cnotmatch '^[0-9a-f]{64}$' -or $Left[$key] -cne $Right[$key]) { return $false }
  }
  return $true
}
$before = Inputs
$buildBefore = Get-Content -LiteralPath (Join-Path $raw 'inputs-before.json') -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
$buildAfter = Get-Content -LiteralPath (Join-Path $raw 'inputs-after.json') -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
$ownPath = '.github/scripts/windows-recovery-followup-git-controls.ps1'
if (-not $before.Contains($ownPath) -or -not (Same-Inputs $before $buildBefore) -or -not (Same-Inputs $before $buildAfter)) { throw 'Git control input map differs from the original build' }
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ne $selection.fixtureSha256) { throw 'Git control programs changed after build' }
$prefix = 'git-launch-controls-' + $Mode
$before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.inputs-before.json')) -Encoding utf8
$cases = if ($Mode -ceq 'LaunchContracts') {
  @(
    @{ name = 'generic-command-shape'; test = 'windows_process::tests::prepared_command_preserves_explicit_values_and_literal_argv'; marker = $null }
    @{ name = 'generic-stdio-contract'; test = 'windows_process::behavior_tests::helper_preserves_literal_arguments_stdio_cwd_environment_and_exit_code'; marker = $null }
    @{ name = 'noninteractive-git-stdio-contract'; test = 'windows_process::behavior_tests::noninteractive_git_helper_preserves_literal_arguments_stdio_cwd_environment_and_exit_code'; marker = $null }
    @{ name = 'noninteractive-git-error-contract'; test = 'windows_process::behavior_tests::noninteractive_git_helper_preserves_stderr_and_original_failure_exit'; marker = $null }
  )
} else {
  @(
    @{ name = 'natural-tail'; test = 'worktrees::git::settlement_tests::original_exit_waits_for_same_job_natural_end_and_collects_descendant_tail'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=tail' }
    @{ name = 'original-nonzero'; test = 'worktrees::git::settlement_tests::naturally_settled_job_preserves_original_nonzero_exit_code'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=tail' }
    @{ name = 'cancel-owned-job'; test = 'worktrees::git::settlement_tests::cancellation_after_original_exit_reaps_same_job_before_return'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=tail' }
    @{ name = 'original-deadline'; test = 'worktrees::git::settlement_tests::original_deadline_still_limits_live_job_after_original_exit'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=tail' }
    @{ name = 'late-stdout-limit'; test = 'worktrees::git::settlement_tests::late_stdout_over_limit_after_original_exit_is_not_success'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=stdout' }
    @{ name = 'late-stderr-limit'; test = 'worktrees::git::settlement_tests::late_stderr_over_limit_after_original_exit_is_not_success'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=stderr' }
    @{ name = 'changed-input'; test = 'worktrees::git::settlement_tests::changed_finite_input_after_original_exit_is_not_success'; marker = 'FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action=input' }
  )
}
$results = @()
$complete = $true
foreach ($case in $cases) {
  $casePrefix = $prefix + '-' + $case.name
  $stdout = Join-Path $raw ($casePrefix + '.stdout.log')
  $stderr = Join-Path $raw ($casePrefix + '.stderr.log')
  $started = [DateTime]::UtcNow.ToString('o')
  # No retries, privilege change or parent-side success synthesis. If the step
  # is externally timed out, unfinished raw files remain without a final receipt.
  & $binary $case.test --exact --nocapture --test-threads=1 1> $stdout 2> $stderr
  $testExit = $LASTEXITCODE
  $finished = [DateTime]::UtcNow.ToString('o')
  $out = [IO.File]::ReadAllText($stdout)
  $err = [IO.File]::ReadAllText($stderr)
  $summaries = [regex]::Matches($out, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
  $summary = if ($summaries.Count -eq 1) { $summaries[0] } else { $null }
  $outcomes = @([regex]::Matches($out, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. (?<outcome>ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$') | ForEach-Object {
    [ordered]@{ name = $_.Groups['name'].Value; outcome = $_.Groups['outcome'].Value }
  })
  $namesExact = $outcomes.Count -eq 1 -and $outcomes[0].name -ceq $case.test -and $outcomes[0].outcome -ceq 'ok'
  $markerCount = if ($case.marker) { [regex]::Matches($err, '(?m)^' + [regex]::Escape($case.marker) + '\r?$').Count } else { 0 }
  $passed = $testExit -eq 0 -and $null -ne $summary -and $summary.Groups['status'].Value -ceq 'ok' -and $summary.Groups['passed'].Value -ceq '1' -and $summary.Groups['failed'].Value -ceq '0' -and $summary.Groups['ignored'].Value -ceq '0' -and $namesExact
  if ($case.marker -and $markerCount -ne 1) { $passed = $false }
  if (-not $passed) { $complete = $false }
  $entry = [ordered]@{
    head = $head; mode = $Mode; name = $case.name; filter = $case.test
    exactFilter = $true; explicitIgnored = $false
    startedAtUtc = $started; finishedAtUtc = $finished
    invocationReturned = $true; terminationRequestedByRunner = $false; exitCode = $testExit
    summaryCount = $summaries.Count; finalSummary = if ($summary) { $summary.Value } else { $null }
    actualNamedOutcomes = $outcomes; namesExact = $namesExact
    expectedPhaseMarker = $case.marker; phaseMarkerMatches = $markerCount
    exactPassed = $passed
    stdoutSha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash
    stderrSha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash
  }
  $entry | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $raw ($casePrefix + '.result.json')) -Encoding utf8
  $results += $entry
  Get-Content -LiteralPath $stdout
  Get-Content -LiteralPath $stderr
}
$after = Inputs
$after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.inputs-after.json')) -Encoding utf8
$finalHead = (& git rev-parse HEAD).Trim()
$headStable = $LASTEXITCODE -eq 0 -and $finalHead -ceq $head
$inputsStable = (Same-Inputs $before $after) -and (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -eq $selection.testBinarySha256 -and (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $selection.fixtureSha256 -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -eq $scriptHash
$complete = $complete -and $results.Count -eq $cases.Count -and $headStable -and $inputsStable
[ordered]@{
  schema = 1; head = $head; finalHead = $finalHead; headStable = $headStable
  mode = $Mode; selectedTests = $cases.Count; groupCount = $results.Count
  selectedCaseNames = @($cases | ForEach-Object { $_.name }); groups = $results
  testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
  runnerScriptSha256 = $scriptHash; inputsStable = $inputsStable; sourceMapMatchesSelectedBuild = $true
  exactAllPassed = $complete; originalInventoriesChanged = $false; productOrAllWindowsComplete = $false
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.result.json')) -Encoding utf8
if (-not $complete) { exit 1 }
exit 0
