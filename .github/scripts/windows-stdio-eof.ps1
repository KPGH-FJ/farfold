param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$test = 'windows_process::behavior_tests::helper_stdout_eof_is_independent_of_selected_exit_with_open_pipe_countercontrol'
$prefix = 'stdio-eof'
$stdout = Join-Path $raw ($prefix + '.stdout.log')
$stderr = Join-Path $raw ($prefix + '.stderr.log')
$inputScopes = @('src-tauri/src', 'src-tauri/native', 'src-tauri/examples', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/*.json', 'src-tauri/*.manifest', '.github/scripts', '.github/workflows/windows-diagnostics.yml')
function Inputs([switch]$CaptureChangedSource) {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read EOF diagnostic source head' }
  if (-not $CaptureChangedSource) {
    if ($head -cne $ExpectedHead) { throw 'EOF diagnostic source head changed' }
    & git diff --quiet --no-ext-diff HEAD -- @inputScopes
    if ($LASTEXITCODE -ne 0) { throw 'EOF diagnostic inputs differ from the dispatched source' }
  }
  $paths = @(& git ls-files -- @inputScopes | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 100) { throw 'EOF diagnostic source map incomplete' }
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
function Read-Markers([string]$Text, [string]$Marker, [string[]]$BooleanFields, [bool]$IsCleanup, [string[]]$NullableIntegerFields = @()) {
  $records = @()
  $parsedRecords = @()
  $errors = @()
  $prefixCount = [regex]::Matches($Text, '(?m)^' + [regex]::Escape($Marker) + '(?: |\r?$)').Count
  $matches = [regex]::Matches($Text, '(?m)^' + [regex]::Escape($Marker) + ' (?<json>\{[^\r\n]*\})\r?$')
  foreach ($match in $matches) {
    try {
      $record = $match.Groups['json'].Value | ConvertFrom-Json -AsHashtable -ErrorAction Stop
      $parsedRecords += $record
      $keys = @('case') + $BooleanFields + $NullableIntegerFields
      if ($IsCleanup) { $keys += 'helperExitCode' }
      if ($record.Count -ne $keys.Count) { throw 'Marker field count differs from the fixed schema' }
      foreach ($key in $keys) { if (-not $record.Contains($key)) { throw "Missing marker field: $key" } }
      if ($record['case'] -isnot [string] -or $record['case'] -cnotin @('held-open', 'closed')) { throw 'Unknown marker case' }
      foreach ($key in $BooleanFields) { if ($record[$key] -isnot [bool]) { throw "Marker field is not boolean: $key" } }
      foreach ($key in $NullableIntegerFields) {
        if ($null -ne $record[$key] -and $record[$key] -isnot [int] -and $record[$key] -isnot [long]) { throw "Marker field is not a nullable integer: $key" }
      }
      if ($IsCleanup -and $record['helperExitCode'] -isnot [int] -and $record['helperExitCode'] -isnot [long]) { throw 'Helper exit is not an integer' }
      $records += $record
    } catch { $errors += $_.Exception.Message }
  }
  $casesExact = $records.Count -eq 2 -and @($records | Where-Object { $_['case'] -ceq 'held-open' }).Count -eq 1 -and @($records | Where-Object { $_['case'] -ceq 'closed' }).Count -eq 1
  return [ordered]@{ prefixCount = $prefixCount; matchedLines = $matches.Count; parsedRecords = $parsedRecords; records = $records; errors = $errors; structureComplete = $prefixCount -eq 2 -and $matches.Count -eq 2 -and $errors.Count -eq 0 -and $casesExact }
}

$started = [DateTime]::UtcNow.ToString('o')
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
$before = $null
$after = $null
$selection = $null
$selectionHash = $null
$binary = $null
$fixture = $null
$invoked = $false
$returned = $false
$testExit = $null
$failure = $null
$summaries = @()
$outcomes = @()
$summary = $null
$observations = $null
$cleanups = $null
$selectedMarkers = $null
$exactOnePassed = $false
$exactOneFailed = $false
$expectedObservations = $false
$cleanupConfirmed = $false
$sourceMapMatchesBuild = $false
$inputsStable = $false
$programsStable = $false
$headStable = $false
$sourceMatchesCommit = $false
$finalHead = $null
$runnerExit = 1
try {
  $selectionPath = Join-Path $raw 'build-selection.json'
  $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json -ErrorAction Stop
  $selectionHash = (Get-FileHash -LiteralPath $selectionPath -Algorithm SHA256).Hash
  if ($selection.sourceHead -cne $ExpectedHead -or $selection.cohort -cne 'StdioEof' -or $selection.sourceInputsStable -isnot [bool] -or -not $selection.sourceInputsStable -or $selection.testBuildExit -ne 0 -or $selection.fixtureBuildExit -ne 0) { throw 'EOF diagnostic selected build incomplete or different' }
  $before = Inputs
  $before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.inputs-before.json')) -Encoding utf8
  $buildBeforePath = Join-Path $raw 'inputs-before.json'
  $buildAfterPath = Join-Path $raw 'inputs-after.json'
  $buildBefore = Get-Content -LiteralPath $buildBeforePath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  $buildAfter = Get-Content -LiteralPath $buildAfterPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  $sourceMapMatchesBuild = (Same-Inputs $before $buildBefore) -and (Same-Inputs $before $buildAfter)
  if (-not $sourceMapMatchesBuild -or (Get-FileHash -LiteralPath $buildBeforePath -Algorithm SHA256).Hash -cne $selection.inputsBeforeSha256 -or (Get-FileHash -LiteralPath $buildAfterPath -Algorithm SHA256).Hash -cne $selection.inputsAfterSha256 -or $before['.github/scripts/windows-selected-build.ps1'] -ine $selection.buildScriptSha256 -or $before['.github/scripts/windows-stdio-eof.ps1'] -ine $scriptHash -or $before['.github/scripts/windows-stdio-eof.ps1'] -ine $selection.stdioRunnerSha256 -or $before['.github/workflows/windows-diagnostics.yml'] -ine $selection.workflowSha256) { throw 'EOF diagnostic map or script hashes differ from the selected build' }
  $binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
  $fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
  $deps = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/deps')) + [IO.Path]::DirectorySeparatorChar
  $expectedFixture = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/examples/windows_process_fixture.exe'))
  if (-not $binary.StartsWith($deps, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($binary) -ne '.exe' -or -not $fixture.Equals($expectedFixture, [StringComparison]::OrdinalIgnoreCase)) { throw 'EOF diagnostic program path differs from the owned selected build' }
  if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -cne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -cne $selection.fixtureSha256) { throw 'EOF diagnostic programs changed after build' }
  # One fixed libtest invocation. The two controls are internal cases, not two
  # tests. No retry, timeout wrapper, process signal, or reader replacement.
  $invoked = $true
  & $binary $test --exact --nocapture --test-threads=1 1> $stdout 2> $stderr
  $testExit = [int]$LASTEXITCODE
  $returned = $true
  $out = [IO.File]::ReadAllText($stdout)
  $err = [IO.File]::ReadAllText($stderr)
  $summaries = [regex]::Matches($out, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
  $summary = if ($summaries.Count -eq 1) { $summaries[0] } else { $null }
  $outcomes = @([regex]::Matches($out, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. (?<outcome>ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$') | ForEach-Object {
    [ordered]@{ name = $_.Groups['name'].Value; outcome = $_.Groups['outcome'].Value }
  })
  $nameExact = $outcomes.Count -eq 1 -and $outcomes[0].name -ceq $test
  $exactOnePassed = $testExit -eq 0 -and $null -ne $summary -and $nameExact -and $outcomes[0].outcome -ceq 'ok' -and $summary.Groups['status'].Value -ceq 'ok' -and $summary.Groups['passed'].Value -ceq '1' -and $summary.Groups['failed'].Value -ceq '0' -and $summary.Groups['ignored'].Value -ceq '0'
  $exactOneFailed = $testExit -eq 101 -and $null -ne $summary -and $nameExact -and $outcomes[0].outcome -ceq 'FAILED' -and $summary.Groups['status'].Value -ceq 'FAILED' -and $summary.Groups['passed'].Value -ceq '0' -and $summary.Groups['failed'].Value -ceq '1' -and $summary.Groups['ignored'].Value -ceq '0'
  $observations = Read-Markers $err 'FARFOLD_STDIO_EOF_OBSERVATION' @('selectedStdoutClosed', 'eofBeforeRelease', 'selectedAliveBeforeRelease', 'helperAliveBeforeRelease', 'jobActiveBeforeRelease', 'stderrAliveBeforeRelease', 'markerComplete', 'stdoutProbeFailed', 'jobQuerySucceededBeforeRelease') $false @('stdoutProbeError')
  $cleanups = Read-Markers $err 'FARFOLD_STDIO_EOF_CLEANUP' @('selectedExited', 'helperReaped', 'jobInactive', 'stdoutEofAfterReap', 'stderrEofAfterReap') $true
  $selectedMarkers = Read-Markers $err 'FARFOLD_STDIO_SELECTED' @('pipeConfirmed', 'closeAttempted', 'closeSucceeded') $false
  $expectedObservations = $observations.structureComplete -and $selectedMarkers.structureComplete
  foreach ($record in $observations.records) {
    $closed = $record['case'] -ceq 'closed'
    if ($record['selectedStdoutClosed'] -ne $closed -or $record['eofBeforeRelease'] -ne $closed -or -not $record['selectedAliveBeforeRelease'] -or -not $record['helperAliveBeforeRelease'] -or -not $record['jobActiveBeforeRelease'] -or -not $record['stderrAliveBeforeRelease'] -or -not $record['markerComplete'] -or $record['stdoutProbeFailed'] -or $null -ne $record['stdoutProbeError'] -or -not $record['jobQuerySucceededBeforeRelease']) { $expectedObservations = $false }
  }
  foreach ($record in $selectedMarkers.records) {
    $closed = $record['case'] -ceq 'closed'
    if (-not $record['pipeConfirmed'] -or $record['closeAttempted'] -ne $closed -or $record['closeSucceeded'] -ne $closed) { $expectedObservations = $false }
  }
  $cleanupConfirmed = $cleanups.structureComplete
  foreach ($record in $cleanups.records) {
    if (-not $record['selectedExited'] -or $record['helperExitCode'] -ne 23 -or -not $record['helperReaped'] -or -not $record['jobInactive'] -or -not $record['stdoutEofAfterReap'] -or -not $record['stderrEofAfterReap']) { $cleanupConfirmed = $false }
  }
} catch {
  $failure = $_.Exception.Message
  Write-Output $failure
} finally {
  $afterFailure = $null
  try {
    $after = Inputs -CaptureChangedSource
    $after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.inputs-after.json')) -Encoding utf8
    $inputsStable = (Same-Inputs $before $after) -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ceq $scriptHash
    $finalHead = (& git rev-parse HEAD).Trim()
    $headStable = $LASTEXITCODE -eq 0 -and $finalHead -ceq $ExpectedHead
    & git diff --quiet --no-ext-diff HEAD -- @inputScopes
    $sourceMatchesCommit = $LASTEXITCODE -eq 0
    if ($null -ne $binary -and $null -ne $fixture) {
      $programsStable = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ceq $selection.testBinarySha256 -and (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ceq $selection.fixtureSha256 -and (Get-FileHash -LiteralPath (Join-Path $raw 'build-selection.json') -Algorithm SHA256).Hash -ceq $selectionHash
    }
  } catch { $afterFailure = $_.Exception.Message }
  $markerStructureComplete = $null -ne $observations -and $observations.structureComplete -and $null -ne $cleanups -and $cleanups.structureComplete -and $null -ne $selectedMarkers -and $selectedMarkers.structureComplete
  $observationComplete = $returned -and ($exactOnePassed -or $exactOneFailed) -and $markerStructureComplete -and $sourceMapMatchesBuild -and $inputsStable -and $programsStable -and $headStable -and $sourceMatchesCommit
  $passed = $null -eq $failure -and $observationComplete -and $exactOnePassed -and $expectedObservations -and $cleanupConfirmed
  if ($passed) { $runnerExit = 0 } elseif ($returned -and $testExit -ne 0) { $runnerExit = $testExit }
  $rawHashes = [ordered]@{}
  foreach ($name in @(($prefix + '.stdout.log'), ($prefix + '.stderr.log'), ($prefix + '.inputs-before.json'), ($prefix + '.inputs-after.json'))) {
    $path = Join-Path $raw $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { $rawHashes[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  }
  [ordered]@{
    schema = 1; sourceHead = $ExpectedHead; cohort = 'StdioEof'; test = $test; selectedTests = 1; internalCases = @('held-open', 'closed')
    exactFilter = $true; explicitIgnored = $false; automaticRetries = 0
    startedAtUtc = $started; finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    invocationStarted = $invoked; invocationReturned = $returned; terminationRequestedByRunner = $false; exitCode = $testExit
    summaryCount = $summaries.Count; finalSummary = if ($summary) { $summary.Value } else { $null }; actualNamedOutcomes = $outcomes
    exactOnePassed = $exactOnePassed; exactOneFailed = $exactOneFailed; testPassed = $exactOnePassed
    observations = $observations; cleanups = $cleanups; selectedMarkers = $selectedMarkers; markerStructureComplete = $markerStructureComplete
    expectedObservations = $expectedObservations; cleanupConfirmed = $cleanupConfirmed; observationComplete = $observationComplete
    sourceMapMatchesSelectedBuild = $sourceMapMatchesBuild; inputsStable = $inputsStable; programsStable = $programsStable
    finalHead = $finalHead; headStable = $headStable; sourceMatchesDispatchedCommit = $sourceMatchesCommit
    buildSelectionSha256 = $selectionHash; runnerScriptSha256 = $scriptHash
    testBinarySha256 = if ($selection) { $selection.testBinarySha256 } else { $null }; fixtureSha256 = if ($selection) { $selection.fixtureSha256 } else { $null }
    rawFileSha256 = $rawHashes; failure = $failure; afterSnapshotFailure = $afterFailure
    exactPassed = $passed; runnerExitCode = $runnerExit; productOrAllWindowsComplete = $false
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $raw ($prefix + '.result.json')) -Encoding utf8
  foreach ($path in @($stdout, $stderr)) { if (Test-Path -LiteralPath $path -PathType Leaf) { Get-Content -LiteralPath $path } }
}
exit $runnerExit
