param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
  [ValidateSet('Legacy', 'StdioEof', 'LaunchPrerequisites')][string]$Scope = 'Legacy',
  [string]$SelectedCohort
)

$ErrorActionPreference = 'Stop'
if ($Scope -ceq 'LaunchPrerequisites' -and [string]::IsNullOrWhiteSpace($SelectedCohort)) {
  throw 'Selected test cohort is required for this build'
}
$PSNativeCommandUseErrorActionPreference = $false
$raw = Join-Path $PWD 'windows-diagnostics-raw'
New-Item -ItemType Directory -Path $raw -ErrorAction Stop | Out-Null
$workflow = if ($Scope -ceq 'LaunchPrerequisites') { '.github/workflows/windows-launch-prerequisites.yml' } else { '.github/workflows/windows-diagnostics.yml' }
$inputScopes = @('src-tauri/src', 'src-tauri/native', 'src-tauri/examples', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/*.json', 'src-tauri/*.manifest', '.github/scripts', $workflow)
if ($Scope -ceq 'LaunchPrerequisites' -and $SelectedCohort -cin @('OpenFailureDiagnostics', 'McpScope', 'RecoveryApproval')) {
  $inputScopes += @('src', 'package.json', 'pnpm-lock.yaml', 'tsconfig*.json', 'vite.config.ts', 'vitest.config.ts', 'index.html')
}
$requiredScripts = @('.github/scripts/windows-selected-build.ps1', '.github/scripts/windows-stdio-eof.ps1', '.github/scripts/windows-stdout-controls.ps1')
if ($Scope -ceq 'LaunchPrerequisites') { $requiredScripts += '.github/scripts/windows-launch-prerequisites.ps1' }
function Inputs([switch]$CaptureChangedSource) {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read selected build source head' }
  if (-not $CaptureChangedSource) {
    if ($head -cne $ExpectedHead) { throw 'Checked out head does not match the single dispatched head' }
    & git diff --quiet --no-ext-diff HEAD -- @inputScopes
    if ($LASTEXITCODE -ne 0) { throw 'Selected build inputs differ from the dispatched source' }
  }
  $paths = @(& git ls-files -- @inputScopes | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 100) { throw 'Selected build source map incomplete' }
  $map = [ordered]@{}
  foreach ($path in $paths) {
    $map[$path] = if ($CaptureChangedSource -and -not (Test-Path -LiteralPath $path -PathType Leaf)) { $null } else { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  foreach ($required in @($requiredScripts) + @($workflow)) {
    if (-not $map.Contains($required)) { throw "Selected build input missing: $required" }
  }
  return $map
}
function Same-Inputs($Left, $Right) {
  if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
  foreach ($key in $Left.Keys) { if (-not $Right.Contains($key) -or $Left[$key] -cne $Right[$key]) { return $false } }
  return $true
}
# The legacy scope text is retained verbatim from the original inline build.
$legacyScope = 'selected parser/publication/originalTerminalCancel/auth2/partialADS/SDK-path/material16/privateInput7/artifact6/firstImport7/sourceExport5/materialEntry5/preparationCache4/bundleGraph9/producerPairing3/offlineGraph6/carrierPortable20Ordinary2/sourceRoots4/sourceGraph9/materialDirectoryBudget11/rawContentStream12/carrierFragment7/rawName5/rawPinOrdinary7/ownedRelativeLinks6/checkoutProfile6/shapeFraming2/shapeOwned4/carrierFullSD4/rawPinFullSD1/ownedLinkFullSD1/gitPathForms4/directoryParser7/directoryFacet9/directoryOrdinary3/directoryFullSD1/directoryRestoreWindowsSharedApi3/directoryRestoreOrdinary3/directoryRestoreFullSD1/directoryTreeCodec6/directoryTreeOrdinary4/directoryTreeFullSD1/regularSharedGuard2IncludingInertFake1/regularSharedOrdinaryPurposeRefusal1/regularSharedFullSD3/gitKnownConfigFiveCall1SeparateDiagnostic/continuation30SeparateMixed12Alias9GitPlain4RawGuid3OwnedLinkSharing2/ownedPersistentTargetRole24/sealedTree8/managedEdge8/ordinaryLink2552SeparateCohort42/ownedLinkAllocationTransition1SeparateExact/legacyFullSecurity27SeparateConditioned positives plus strict master-retirement bounded-unknown negative only'
$identityScope = switch -CaseSensitive ($Scope) {
  'Legacy' { $legacyScope }
  'StdioEof' { 'one exact synthetic stdout EOF test with held-open and closed-stdout internal controls plus five exact preservation tests; not product or whole-Windows acceptance' }
  'LaunchPrerequisites' { 'selected native test build; exact cases and arguments are recorded by the test runner' }
}
$started = [DateTime]::UtcNow.ToString('o')
$before = $null
$after = $null
$testBuildExit = $null
$fixtureBuildExit = $null
$binary = $null
$fixture = $null
$failure = $null
$buildSucceeded = $false
$runnerExit = 1
$syntaxChecks = @()
$buildScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
try {
  $before = Inputs
  $before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'inputs-before.json') -Encoding utf8
  $identity = [ordered]@{ head = $ExpectedHead; sourceHead = $ExpectedHead; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; cohort = $Scope; scope = $identityScope }
  if ($Scope -ceq 'LaunchPrerequisites') { $identity['selectedCohort'] = $SelectedCohort }
  $identity | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $raw 'identity.json') -Encoding utf8
  foreach ($path in $requiredScripts) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD $path), [ref]$tokens, [ref]$parseErrors)
    $syntaxChecks += [ordered]@{ path = $path; sha256 = $before[$path]; parseErrors = @($parseErrors | ForEach-Object { $_.Message }) }
    if ($parseErrors.Count -ne 0) { throw "Selected diagnostic PowerShell syntax invalid: $path" }
  }
  & cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json 1> (Join-Path $raw 'test-build.stdout.jsonl') 2> (Join-Path $raw 'test-build.stderr.log')
  $testBuildExit = [int]$LASTEXITCODE
  Get-Content -LiteralPath (Join-Path $raw 'test-build.stderr.log')
  if ($testBuildExit -ne 0) { $runnerExit = $testBuildExit; throw 'Selected test build returned a failure exit' }
  $executables = @(Get-Content -LiteralPath (Join-Path $raw 'test-build.stdout.jsonl') | ForEach-Object {
    $message = $_ | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    if ($message.reason -eq 'compiler-artifact' -and $message.target.name -eq 'farfold_lib' -and $message.profile.test -eq $true -and $message.executable) { $message.executable }
  } | Select-Object -Unique)
  if ($executables.Count -ne 1) { throw 'Expected exactly one built farfold_lib test executable' }
  $binary = (Resolve-Path -LiteralPath $executables[0] -ErrorAction Stop).Path
  $deps = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/deps')) + [IO.Path]::DirectorySeparatorChar
  if (-not $binary.StartsWith($deps, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($binary) -ne '.exe') { throw 'Unexpected test executable location' }
  & cargo build --manifest-path src-tauri/Cargo.toml --locked --example windows_process_fixture 1> (Join-Path $raw 'fixture-build.stdout.log') 2> (Join-Path $raw 'fixture-build.stderr.log')
  $fixtureBuildExit = [int]$LASTEXITCODE
  Get-Content -LiteralPath (Join-Path $raw 'fixture-build.stdout.log')
  Get-Content -LiteralPath (Join-Path $raw 'fixture-build.stderr.log')
  if ($fixtureBuildExit -ne 0) { $runnerExit = $fixtureBuildExit; throw 'Selected fixture build returned a failure exit' }
  $fixture = (Resolve-Path -LiteralPath 'src-tauri/target/debug/examples/windows_process_fixture.exe' -ErrorAction Stop).Path
  $after = Inputs -CaptureChangedSource
  $after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'inputs-after.json') -Encoding utf8
  $finalHead = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $finalHead -cne $ExpectedHead) { throw 'Selected build source head changed' }
  & git diff --quiet --no-ext-diff HEAD -- @inputScopes
  if ($LASTEXITCODE -ne 0) { throw 'Selected build source changed from the dispatched commit' }
  if (-not (Same-Inputs $before $after)) { throw 'Selected build inputs changed' }
  $selection = [ordered]@{
    sourceHead = $ExpectedHead; cohort = $Scope
    testBinary = $binary; testBinarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    fixture = $fixture; fixtureSha256 = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
    testBuildExit = $testBuildExit; fixtureBuildExit = $fixtureBuildExit; sourceInputsStable = $true
    inputsBeforeSha256 = (Get-FileHash -LiteralPath (Join-Path $raw 'inputs-before.json') -Algorithm SHA256).Hash
    inputsAfterSha256 = (Get-FileHash -LiteralPath (Join-Path $raw 'inputs-after.json') -Algorithm SHA256).Hash
    buildScriptSha256 = $buildScriptSha256
    workflowSha256 = $after[$workflow]
    stdioRunnerSha256 = $after['.github/scripts/windows-stdio-eof.ps1']
  }
  if ($Scope -ceq 'LaunchPrerequisites') { $selection['selectedCohort'] = $SelectedCohort }
  $selection | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $raw 'build-selection.json') -Encoding utf8
  $buildSucceeded = $true
  $runnerExit = 0
} catch {
  $failure = $_.Exception.Message
  Write-Output $failure
} finally {
  $afterFailure = $null
  if ($null -eq $after) {
    try {
      $after = Inputs -CaptureChangedSource
      $after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'inputs-after.json') -Encoding utf8
    } catch { $afterFailure = $_.Exception.Message }
  }
  $rawHashes = [ordered]@{}
  foreach ($name in @('test-build.stdout.jsonl', 'test-build.stderr.log', 'fixture-build.stdout.log', 'fixture-build.stderr.log', 'inputs-before.json', 'inputs-after.json', 'identity.json', 'build-selection.json')) {
    $path = Join-Path $raw $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { $rawHashes[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  }
  [ordered]@{
    schema = 1; sourceHead = $ExpectedHead; cohort = $Scope
    startedAtUtc = $started; finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    testBuildExit = $testBuildExit; fixtureBuildExit = $fixtureBuildExit
    sourceInputsStable = Same-Inputs $before $after
    buildSucceeded = $buildSucceeded; failure = $failure; afterSnapshotFailure = $afterFailure; syntaxChecks = $syntaxChecks
    buildScriptSha256 = $buildScriptSha256; rawFileSha256 = $rawHashes
    runnerExitCode = $runnerExit; testsInvoked = $false; productOrAllWindowsComplete = $false
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $raw 'selected-build.result.json') -Encoding utf8
}
exit $runnerExit
