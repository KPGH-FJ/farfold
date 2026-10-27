param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$selectionPath = Join-Path $raw 'build-selection.json'
$inputScopes = @('src-tauri/src', 'src-tauri/native', 'src-tauri/examples', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/*.json', 'src-tauri/*.manifest', '.github/scripts', '.github/workflows/windows-diagnostics.yml')
function Inputs([switch]$CaptureChangedSource) {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read preservation-control source head' }
  if (-not $CaptureChangedSource) {
    if ($head -cne $ExpectedHead) { throw 'Preservation-control source head changed' }
    & git diff --quiet --no-ext-diff HEAD -- @inputScopes
    if ($LASTEXITCODE -ne 0) { throw 'Preservation-control source differs from the dispatched commit' }
  }
  $paths = @(& git ls-files -- @inputScopes | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 100) { throw 'Preservation-control source map incomplete' }
  $map = [ordered]@{}
  foreach ($path in $paths) {
    $map[$path] = if ($CaptureChangedSource -and -not (Test-Path -LiteralPath $path -PathType Leaf)) { $null } else { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  return $map
}
function Same-Inputs($Left, $Right) {
  if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
  foreach ($key in $Left.Keys) {
    if (-not $Right.Contains($key) -or $Left[$key] -isnot [string] -or $Right[$key] -isnot [string] -or $Left[$key] -cnotmatch '^[0-9a-f]{64}$' -or $Left[$key] -cne $Right[$key]) { return $false }
  }
  return $true
}
function Read-NativeGuard([string]$Text) {
  $prefixCount = [regex]::Matches($Text, '(?m)^FARFOLD_STDOUT_HANDOFF_GUARDS(?: |\r?$)').Count
  $matches = [regex]::Matches($Text, '(?m)^FARFOLD_STDOUT_HANDOFF_GUARDS (?<json>\{[^\r\n]*\})\r?$')
  if ($prefixCount -ne 1 -or $matches.Count -ne 1) { throw 'Expected one complete native guard marker' }
  $record = $matches[0].Groups['json'].Value | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  $names = @('exclusive-inheritable', 'exclusive-noninheritable', 'stdout-equals-stderr', 'stdout-equals-stdin', 'nul', 'ordinary-file', 'null', 'invalid', 'protect-from-close', 'write-only-query-denied')
  foreach ($field in @('schemaVersion', 'caseCount', 'requiredCaseCount', 'fixtureExitCode')) {
    if ($record[$field] -isnot [int] -and $record[$field] -isnot [long]) { throw "Native guard field is not an integer: $field" }
  }
  if ($record.schemaVersion -ne 1 -or $record.caseCount -ne 10 -or $record.requiredCaseCount -ne 10 -or $record.cases.Count -ne 10 -or $record.fixtureExitCode -ne 0) { throw 'Native guard marker schema or fixture exit differs' }
  foreach ($field in @('originalSlotsRestored', 'fixtureExited', 'queryDeniedNegativeExercised')) {
    if ($record[$field] -isnot [bool] -or -not $record[$field]) { throw "Native guard field is not confirmed: $field" }
  }
  for ($index = 0; $index -lt $names.Count; $index++) {
    $case = $record.cases[$index]
    if ($case['case'] -cne $names[$index] -or $case['prepared'] -isnot [bool] -or $case['prepared'] -ne ($index -lt 2)) { throw 'Native guard case name or preparation differs' }
    foreach ($field in @('passed', 'slotsUnchangedDuring', 'slotsUnchangedAfterDrop', 'flagsRestored', 'handlesRetained', 'preparedFlagsSafe')) {
      if ($case[$field] -isnot [bool] -or -not $case[$field]) { throw "Native guard case field is not confirmed: $field" }
    }
  }
  return [ordered]@{ complete = $true; prefixCount = $prefixCount; parsed = $record; error = $null }
}

$tests = @(
  'windows_process::behavior_tests::helper_stdout_handoff_native_guards_preserve_standard_handles',
  'windows_process::behavior_tests::helper_preserves_literal_arguments_stdio_cwd_environment_and_exit_code',
  'windows_process::behavior_tests::helper_failure_never_starts_selected_work',
  'acp_client::lifecycle_tests::stdout_eof_does_not_wait_for_stderr_or_a_living_child',
  'acp_client::identity_read::tests::identity_read_unwitnessed_transport_error_survives_actor_end_until_actual_reap'
)
$started = [DateTime]::UtcNow.ToString('o')
$before = $null
$after = $null
$selection = $null
$selectionHash = $null
$binary = $null
$fixture = $null
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
$results = @()
$failure = $null
$sourceMapMatchesBuild = $false
$inputsStable = $false
$programsStable = $false
$headStable = $false
$sourceMatchesCommit = $false
$firstTestFailure = $null
$nativeGuard = [ordered]@{ complete = $false; prefixCount = $null; parsed = $null; error = 'Native guard not read' }
$runnerExit = 1
try {
  $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json -ErrorAction Stop
  $selectionHash = (Get-FileHash -LiteralPath $selectionPath -Algorithm SHA256).Hash
  if ($selection.sourceHead -cne $ExpectedHead -or $selection.cohort -cne 'StdioEof' -or $selection.sourceInputsStable -isnot [bool] -or -not $selection.sourceInputsStable -or $selection.testBuildExit -ne 0 -or $selection.fixtureBuildExit -ne 0) { throw 'Preservation-control selected build incomplete or different' }
  $before = Inputs
  $before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'stdout-controls.inputs-before.json') -Encoding utf8
  $buildBeforePath = Join-Path $raw 'inputs-before.json'
  $buildAfterPath = Join-Path $raw 'inputs-after.json'
  $buildBefore = Get-Content -LiteralPath $buildBeforePath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  $buildAfter = Get-Content -LiteralPath $buildAfterPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  $sourceMapMatchesBuild = (Same-Inputs $before $buildBefore) -and (Same-Inputs $before $buildAfter)
  if (-not $sourceMapMatchesBuild -or (Get-FileHash -LiteralPath $buildBeforePath -Algorithm SHA256).Hash -cne $selection.inputsBeforeSha256 -or (Get-FileHash -LiteralPath $buildAfterPath -Algorithm SHA256).Hash -cne $selection.inputsAfterSha256 -or $before['.github/scripts/windows-stdout-controls.ps1'] -ine $scriptHash) { throw 'Preservation-control source map or script differs from the selected build' }
  $binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
  $fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
  $deps = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/deps')) + [IO.Path]::DirectorySeparatorChar
  $expectedFixture = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/examples/windows_process_fixture.exe'))
  if (-not $binary.StartsWith($deps, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($binary) -ne '.exe' -or -not $fixture.Equals($expectedFixture, [StringComparison]::OrdinalIgnoreCase)) { throw 'Preservation-control program path differs from the owned build' }
  if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -cne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -cne $selection.fixtureSha256) { throw 'Preservation-control programs changed after build' }
  for ($index = 0; $index -lt $tests.Count; $index++) {
    $test = $tests[$index]
    $prefix = 'stdout-control-' + ($index + 1)
    $stdout = Join-Path $raw ($prefix + '.stdout.log')
    $stderr = Join-Path $raw ($prefix + '.stderr.log')
    $testStarted = [DateTime]::UtcNow.ToString('o')
    & $binary $test --exact --nocapture --test-threads=1 1> $stdout 2> $stderr
    $testExit = [int]$LASTEXITCODE
    if ($testExit -ne 0 -and $null -eq $firstTestFailure) { $firstTestFailure = $testExit }
    $out = [IO.File]::ReadAllText($stdout)
    $summaries = [regex]::Matches($out, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
    $outcomes = @([regex]::Matches($out, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. (?<outcome>ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$') | ForEach-Object { [ordered]@{ name = $_.Groups['name'].Value; outcome = $_.Groups['outcome'].Value } })
    $named = $outcomes.Count -eq 1 -and $outcomes[0].name -ceq $test
    $exact = $testExit -eq 0 -and $named -and $outcomes[0].outcome -ceq 'ok' -and $summaries.Count -eq 1 -and $summaries[0].Groups['status'].Value -ceq 'ok' -and $summaries[0].Groups['passed'].Value -ceq '1' -and $summaries[0].Groups['failed'].Value -ceq '0' -and $summaries[0].Groups['ignored'].Value -ceq '0'
    $results += [ordered]@{ test = $test; exactFilter = $true; invocationReturned = $true; exitCode = $testExit; startedAtUtc = $testStarted; finishedAtUtc = [DateTime]::UtcNow.ToString('o'); summaryCount = $summaries.Count; finalSummary = if ($summaries.Count -eq 1) { $summaries[0].Value } else { $null }; actualNamedOutcomes = $outcomes; exactOnePassed = $exact; stdout = [IO.Path]::GetFileName($stdout); stderr = [IO.Path]::GetFileName($stderr) }
    Get-Content -LiteralPath $stdout
    Get-Content -LiteralPath $stderr
  }
} catch {
  $failure = $_.Exception.Message
  Write-Output $failure
} finally {
  try {
    $nativeGuard = Read-NativeGuard ([IO.File]::ReadAllText((Join-Path $raw 'stdout-control-1.stderr.log')))
  } catch { $nativeGuard = [ordered]@{ complete = $false; prefixCount = $null; parsed = $null; error = $_.Exception.Message } }
  $afterFailure = $null
  try {
    $after = Inputs -CaptureChangedSource
    $after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'stdout-controls.inputs-after.json') -Encoding utf8
    $inputsStable = (Same-Inputs $before $after) -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ceq $scriptHash
    $head = (& git rev-parse HEAD).Trim()
    $headStable = $LASTEXITCODE -eq 0 -and $head -ceq $ExpectedHead
    & git diff --quiet --no-ext-diff HEAD -- @inputScopes
    $sourceMatchesCommit = $LASTEXITCODE -eq 0
    if ($null -ne $binary -and $null -ne $fixture) {
      $programsStable = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ceq $selection.testBinarySha256 -and (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ceq $selection.fixtureSha256 -and (Get-FileHash -LiteralPath $selectionPath -Algorithm SHA256).Hash -ceq $selectionHash
    }
  } catch { $afterFailure = $_.Exception.Message }
  $exactPassed = $null -eq $failure -and $null -eq $afterFailure -and $nativeGuard.complete -and $sourceMapMatchesBuild -and $inputsStable -and $programsStable -and $headStable -and $sourceMatchesCommit -and $results.Count -eq 5 -and @($results | Where-Object { -not $_.exactOnePassed }).Count -eq 0
  if ($exactPassed) { $runnerExit = 0 } elseif ($null -ne $firstTestFailure) { $runnerExit = $firstTestFailure }
  $hashes = [ordered]@{}
  foreach ($name in @('stdout-controls.inputs-before.json', 'stdout-controls.inputs-after.json') + @(1..5 | ForEach-Object { 'stdout-control-' + $_ + '.stdout.log'; 'stdout-control-' + $_ + '.stderr.log' })) {
    $path = Join-Path $raw $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { $hashes[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  }
  [ordered]@{ schema = 1; sourceHead = $ExpectedHead; buildCohort = 'StdioEof'; selectedTests = $tests; automaticRetries = 0; terminationRequestedByRunner = $false; startedAtUtc = $started; finishedAtUtc = [DateTime]::UtcNow.ToString('o'); tests = $results; nativeGuard = $nativeGuard; sourceMapMatchesBuild = $sourceMapMatchesBuild; inputsStable = $inputsStable; programsStable = $programsStable; headStable = $headStable; sourceMatchesDispatchedCommit = $sourceMatchesCommit; buildSelectionSha256 = $selectionHash; runnerScriptSha256 = $scriptHash; rawFileSha256 = $hashes; failure = $failure; afterSnapshotFailure = $afterFailure; exactPassed = $exactPassed; runnerExitCode = $runnerExit; nativeGuardCoverageRequiresRawSemanticReview = $true; productOrAllWindowsComplete = $false } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $raw 'stdout-controls.result.json') -Encoding utf8
}
exit $runnerExit
