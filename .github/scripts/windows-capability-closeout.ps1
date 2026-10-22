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
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $selection.sourceHead -cne $head) { throw 'Closeout controls head differs from selected build' }
$binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
$fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ne $selection.fixtureSha256) { throw 'Closeout controls inputs changed after build' }
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash

# This explicit cohort is separate from all historical inventories. No test
# absence, ignored result or environmental failure is a successful execution.
$casePath = Join-Path $PSScriptRoot 'windows-capability-closeout-cases.json'
$caseHash = (Get-FileHash -LiteralPath $casePath -Algorithm SHA256).Hash
$manifest = Get-Content -LiteralPath $casePath -Raw | ConvertFrom-Json -ErrorAction Stop
if ($manifest.schema -ne 1 -or $manifest.cases.Count -lt 1) { throw 'Invalid closeout case manifest' }
$cases = @($manifest.cases)
$names = @($cases | ForEach-Object { $_.test })
$labels = @($cases | ForEach-Object { $_.name })
foreach ($case in $cases) {
  if ($case.test -cnotmatch '^[A-Za-z0-9_]+(::[A-Za-z0-9_]+)+$' -or $case.name -cnotmatch '^[a-z0-9-]+$' -or $case.manual -isnot [bool] -or -not $case.category) { throw 'Invalid exact test entry' }
}
if (@($names | Select-Object -Unique).Count -ne $cases.Count -or @($labels | Select-Object -Unique).Count -ne $cases.Count) { throw 'Duplicate closeout exact test or label' }
$ordinaryCount = @($cases | Where-Object { -not $_.manual }).Count
$manualCount = @($cases | Where-Object { $_.manual }).Count
$manualMode = $Mode -ceq 'FullSecurityManual'
$selected = @($cases | Where-Object { $_.manual -eq $manualMode })
$expected = if ($manualMode) { $manualCount } else { $ordinaryCount }
if ($expected -lt 1 -or $selected.Count -ne $expected) { throw 'Empty or inconsistent selected closeout inventory' }
$results = @()
$complete = $true
foreach ($case in $selected) {
  $prefix = 'capability-closeout-' + $Mode + '-' + $case.name
  $stdout = Join-Path $raw ($prefix + '.stdout.log')
  $stderr = Join-Path $raw ($prefix + '.stderr.log')
  $started = [DateTime]::UtcNow.ToString('o')
  $selectionArguments = @('--exact')
  if ($manualMode) { $selectionArguments = @('--ignored', '--exact') }
  & $binary $case.test @selectionArguments --nocapture --test-threads=1 1> $stdout 2> $stderr
  $testExit = $LASTEXITCODE
  $finished = [DateTime]::UtcNow.ToString('o')
  $outText = [IO.File]::ReadAllText($stdout)
  $errText = [IO.File]::ReadAllText($stderr)
  $phaseMarker = if ($case.PSObject.Properties.Name -contains 'phaseMarker') { [string]$case.phaseMarker } else { $null }
  $phaseMatches = if ($phaseMarker) { @([regex]::Matches($errText, '(?m)^' + [regex]::Escape($phaseMarker) + '\r?$')) } else { @() }
  $phaseReached = $phaseMarker -and $phaseMatches.Count -eq 1
  $summaries = [regex]::Matches($outText, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
  $last = if ($summaries.Count -eq 1) { $summaries[0] } else { $null }
  $nameMatches = [regex]::Matches($outText, '(?m)^test (?<name>[A-Za-z0-9_:]+) \.\.\. ok\r?$')
  $actualNames = @($nameMatches | ForEach-Object { $_.Groups['name'].Value })
  $namesExact = $actualNames.Count -eq 1 -and $actualNames[0] -ceq $case.test
  $passed = $testExit -eq 0 -and $null -ne $last -and $last.Groups['status'].Value -ceq 'ok' -and $last.Groups['passed'].Value -eq '1' -and $last.Groups['failed'].Value -eq '0' -and $last.Groups['ignored'].Value -eq '0' -and $namesExact
  if ($phaseMarker -and -not $phaseReached) { $passed = $false }
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
    expectedPhaseMarker = $phaseMarker; phaseMarkerMatches = $phaseMatches.Count
    injectionPhaseReached = [bool]$phaseReached
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
$inputsStable = $inputsStable -and (Get-FileHash -LiteralPath $casePath -Algorithm SHA256).Hash -eq $caseHash
$complete = $complete -and $results.Count -eq $expected -and $headStable -and $inputsStable
[ordered]@{
  schema = 1; head = $head; finalHead = $finalHead; headStable = $headStable
  mode = $Mode; testBinarySha256 = $selection.testBinarySha256; fixtureSha256 = $selection.fixtureSha256
  runnerScriptSha256 = $scriptHash; inputsStable = $inputsStable
  plannedOrdinaryTests = $ordinaryCount; plannedManualTests = $manualCount; plannedTotalTests = $cases.Count
  caseManifestSha256 = $caseHash
  selectedTests = $expected; groupCount = $results.Count; groups = $results; exactAllGroupsPassed = $complete
  historicalInventoriesChanged = $false
  explicitManualFailuresAreSuccessfulTests = $false; privilegesAdjusted = $false; fullSecurityFallbackUsed = $false
  syntheticOrOrdinaryRefusalIsNativeSuccess = $false; completePayloadSecurityOrAliasRestoreClaim = $false
  fullTreeOrManifest2Complete = $false; productOrAllWindowsComplete = $false
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $raw ('capability-closeout-' + $Mode + '.result.json')) -Encoding utf8
Get-Content -LiteralPath (Join-Path $raw ('capability-closeout-' + $Mode + '.result.json'))
if (-not $complete) { exit 1 }
exit 0
