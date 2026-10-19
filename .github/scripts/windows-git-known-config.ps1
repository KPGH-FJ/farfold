param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedHead
)

$ErrorActionPreference = 'Stop'
$raw = Join-Path $PWD 'windows-diagnostics-raw'
$selection = Get-Content -LiteralPath (Join-Path $raw 'build-selection.json') -Raw | ConvertFrom-Json
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $selection.sourceHead -cne $head) { throw 'Known-config head differs from selected build' }
$binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
$fixture = (Resolve-Path -LiteralPath $selection.fixture -ErrorAction Stop).Path
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $selection.testBinarySha256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -ne $selection.fixtureSha256) { throw 'Known-config inputs changed after build' }
$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
$stdout = Join-Path $raw 'git-known-config.stdout.log'
$stderr = Join-Path $raw 'git-known-config.stderr.log'
$test = 'worktrees::windows_git::launch_matrix_tests::owned_same_program_known_config_extended_plain_observations_preserve_original_owner'
$case = 'OwnedSameProgramKnownConfigExtendedPlain'
$started = [DateTime]::UtcNow.ToString('o')
& $binary $test --exact --nocapture --test-threads=1 1> $stdout 2> $stderr
$testExit = $LASTEXITCODE
$finished = [DateTime]::UtcNow.ToString('o')
$outText = [IO.File]::ReadAllText($stdout)
$errText = [IO.File]::ReadAllText($stderr)
$summaries = [regex]::Matches($outText, '(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored;')
$last = if ($summaries.Count -eq 1) { $summaries[0] } else { $null }
$oneObservationTestPassed = $testExit -eq 0 -and $null -ne $last -and $last.Groups['status'].Value -ceq 'ok' -and $last.Groups['passed'].Value -eq '1' -and $last.Groups['failed'].Value -eq '0' -and $last.Groups['ignored'].Value -eq '0' -and [regex]::Matches($outText, '(?m)^test ' + [regex]::Escape($test) + ' \.\.\. ok\r?$').Count -eq 1

function Test-Keys($value, $keys) {
  if ($value -isnot [System.Collections.IDictionary]) { return $false }
  $actual = @($value.psbase.Keys | Sort-Object)
  $expected = @($keys | Sort-Object)
  if ($actual.Count -ne $expected.Count) { return $false }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    if ($actual[$index] -isnot [string] -or $actual[$index] -cne $expected[$index]) { return $false }
  }
  return $true
}
# Exercise the same JSON dictionary type before trusting any diagnostic record.
$keyControl = '{"schema":1,"case":"control"}' | ConvertFrom-Json -AsHashtable
$keyCollision = '{"schema":1,"case":"control","Keys":["case","schema"]}' | ConvertFrom-Json -AsHashtable
$keyJoined = '{"case,schema":1}' | ConvertFrom-Json -AsHashtable
if (-not (Test-Keys $keyControl @('schema','case')) -or (Test-Keys $keyCollision @('schema','case')) -or (Test-Keys $keyJoined @('schema','case'))) { throw 'Exact JSON key controls failed' }
function Test-Integer($value) {
  return $value -is [int] -or $value -is [long] -or $value -is [uint64] -or $value -is [bigint]
}
function Test-U64($value) {
  if (-not (Test-Integer $value)) { return $false }
  $number = [bigint]$value
  return $number.Sign -ge 0 -and $number.CompareTo([bigint]::Parse('18446744073709551615')) -le 0
}
foreach ($bound in @([long]0, [long]::MaxValue, [uint64]::MaxValue, [bigint]::Parse('10116456482831564288'))) {
  if (-not (Test-U64 $bound)) { throw 'Valid U64 boundary rejected' }
}
foreach ($outside in @([long]-1, [bigint]::Parse('18446744073709551616'), [double]0, '0')) {
  if (Test-U64 $outside) { throw 'Invalid U64 boundary accepted' }
}
function Test-NullableInteger($value) {
  return $null -eq $value -or (Test-Integer $value)
}
function Test-Digest($value) {
  return $value -is [string] -and $value -cmatch '^[0-9a-f]{64}$'
}
function Test-Owner($value) {
  $keys = @('child_reaped','direct_job_inactive','original_output_cap_checks_passed','input_mode','owned_wrapper_exit','stderr_observed','stderr_prefix_bytes','stderr_prefix_sha256','stderr_prefix_truncated','stderr_observation_error','stderr_class','launcher_phase','launcher_native_error')
  if (-not (Test-Keys $value $keys)) { return $false }
  foreach ($key in @('child_reaped','direct_job_inactive','original_output_cap_checks_passed','stderr_observed')) {
    if ($value[$key] -isnot [bool] -or $value[$key] -ne $true) { return $false }
  }
  if ($value.input_mode -cne 'originalNullStdin' -or $null -ne $value.stderr_observation_error) { return $false }
  if ($value.stderr_prefix_truncated -isnot [bool] -or -not (Test-Integer $value.stderr_prefix_bytes) -or $value.stderr_prefix_bytes -lt 0 -or $value.stderr_prefix_bytes -gt 512 -or -not (Test-Digest $value.stderr_prefix_sha256) -or $value.stderr_class -cnotin @('empty','launcher','otherRedacted')) { return $false }
  if ($null -ne $value.launcher_phase -and $value.launcher_phase -cnotin @('prepare','enterJob','executeOrWait')) { return $false }
  return (Test-NullableInteger $value.owned_wrapper_exit) -and (Test-NullableInteger $value.launcher_native_error)
}

$lines = [regex]::Split($errText, '\r?\n')
$prefix = 'FARFOLD_WINDOWS_GIT_KNOWN_CONFIG '
$records = @($lines | Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) } | ForEach-Object { $_.Substring($prefix.Length) | ConvertFrom-Json -AsHashtable -ErrorAction Stop })
$callPrefix = 'FARFOLD_WINDOWS_GIT_KNOWN_CONFIG_CALL '
$trace = @($lines | Where-Object { $_.StartsWith($callPrefix, [StringComparison]::Ordinal) } | ForEach-Object { $_.Substring($callPrefix.Length) | ConvertFrom-Json -AsHashtable -ErrorAction Stop })
$observation = if ($records.Count -eq 1) { $records[0] } else { $null }
$summaryKeys = @('schema','case','calls','pairedObjects','fixtureCleanup','fixtureCleanupError','observationComplete','plainFileKnownFalse','plainCommonKnownFalse','selectedVersionRecorded','versionPinned','readContextAdmissionProven','existingFailureFixed')
$complete = $oneObservationTestPassed -and (Test-Keys $observation $summaryKeys)
if ($complete) {
  $complete = (Test-Integer $observation.schema) -and $observation.schema -eq 1 -and $observation.case -ceq $case -and $observation.fixtureCleanup -ceq 'knownRemoved' -and $null -eq $observation.fixtureCleanupError -and @($observation.calls).Count -eq 5 -and @($observation.pairedObjects).Count -eq 5 -and $trace.Count -eq 10
  foreach ($key in @('observationComplete','plainFileKnownFalse','plainCommonKnownFalse','selectedVersionRecorded','versionPinned','readContextAdmissionProven','existingFailureFixed')) {
    if ($observation[$key] -isnot [bool]) { $complete = $false }
  }
  $complete = $complete -and $observation.observationComplete -and $observation.plainFileKnownFalse -and $observation.plainCommonKnownFalse -and $observation.selectedVersionRecorded -and -not $observation.versionPinned -and -not $observation.readContextAdmissionProven -and -not $observation.existingFailureFixed
}
$pairKeys = @('case','role','volume','fileId128','size','modified','changed','links','regular')
$roles = @('selectedProgram','root','git','common','ownedConfig')
$pairsValid = 0
if ($complete) {
  for ($index = 0; $index -lt 5; $index++) {
    $pair = $observation.pairedObjects[$index]
    if (-not (Test-Keys $pair $pairKeys)) { $complete = $false; continue }
    $valid = $pair.case -ceq $case -and $pair.role -ceq $roles[$index] -and (Test-U64 $pair.volume) -and (Test-U64 $pair.size) -and (Test-U64 $pair.links) -and $pair.links -gt 0 -and $pair.fileId128 -is [string] -and $pair.fileId128 -cmatch '^[0-9a-f]{32}$' -and $pair.fileId128 -cnotmatch '^0{32}$' -and $pair.regular -is [bool] -and $pair.regular -eq ($index -eq 0 -or $index -eq 4)
    foreach ($field in @('modified','changed')) {
      $stamp = @($pair[$field])
      $valid = $valid -and $stamp.Count -eq 2
      foreach ($value in $stamp) { if (-not (Test-Integer $value)) { $valid = $false } }
    }
    if ($valid) { $pairsValid++ } else { $complete = $false }
  }
}
$callKeys = @('case','order','call','programForm','cwdForm','contextPathArgsForm','commonDirForm','fullIdentityAndStampPrecheck','fullIdentityAndStampPostcheck','executorError','returnedCode','stdoutBytes','stdoutSha256','selectedVersionObservation','knownOwnedConfigFalse','owner','observationComplete')
$labels = @('selectedVersion','fileExtended','filePlain','commonExtended','commonPlain')
$falseLf = '2ed27c1421e6928dbe13dbfdb5c59e1045b30341fe7ebe05700006bc5ac572c0'
$falseCrLf = '75dbba8fd110adbe0bda707bcbfe667247f5a2d590c5380781abcde1ac20062d'
$callsValid = 0
if ($complete) {
  for ($index = 0; $index -lt 5; $index++) {
    $call = $observation.calls[$index]
    if (-not (Test-Keys $call $callKeys)) { $complete = $false; continue }
    $commonForm = if ($index -eq 3) { 'heldExtendedDrive' } else { 'pairedPlain' }
    $valid = $call.case -ceq $case -and (Test-Integer $call.order) -and $call.order -eq ($index + 1) -and $call.call -ceq $labels[$index] -and $call.programForm -ceq 'pairedPlain' -and $call.cwdForm -ceq 'pairedPlain' -and $call.contextPathArgsForm -ceq 'pairedPlain' -and $call.commonDirForm -ceq $commonForm
    foreach ($key in @('fullIdentityAndStampPrecheck','fullIdentityAndStampPostcheck','observationComplete')) {
      if ($call[$key] -isnot [bool] -or $call[$key] -ne $true) { $valid = $false }
    }
    $valid = $valid -and (Test-Owner $call.owner) -and $null -eq $call.executorError -and (Test-NullableInteger $call.returnedCode) -and $call.returnedCode -eq $call.owner.owned_wrapper_exit -and (Test-Integer $call.stdoutBytes) -and $call.stdoutBytes -ge 0 -and $call.stdoutBytes -le 4194304 -and (Test-Digest $call.stdoutSha256) -and $call.knownOwnedConfigFalse -is [bool]
    $knownFalse = $call.returnedCode -eq 0 -and (($call.stdoutBytes -eq 6 -and $call.stdoutSha256 -ceq $falseLf) -or ($call.stdoutBytes -eq 7 -and $call.stdoutSha256 -ceq $falseCrLf))
    $valid = $valid -and $call.knownOwnedConfigFalse -eq $knownFalse
    if ($index -eq 0) {
      $version = $call.selectedVersionObservation
      $valid = $valid -and $call.returnedCode -eq 0 -and $call.stdoutBytes -le 128 -and $version -is [string] -and $version.StartsWith('git version ', [StringComparison]::Ordinal) -and $version.Length -le 128 -and $version.TrimEnd([char[]]@(13,10)) -cmatch '^git version [A-Za-z0-9 .+_()-]+$'
    } elseif ($null -ne $call.selectedVersionObservation) { $valid = $false }
    if (($index -eq 2 -or $index -eq 4) -and -not $knownFalse) { $valid = $false }
    $before = $trace[2 * $index]
    $after = $trace[2 * $index + 1]
    $valid = $valid -and (Test-Keys $before @('case','order','call','phase')) -and (Test-Keys $after @('case','order','call','phase','facts'))
    $valid = $valid -and $before.case -ceq $case -and $after.case -ceq $case -and (Test-Integer $before.order) -and (Test-Integer $after.order) -and $before.order -eq ($index + 1) -and $after.order -eq ($index + 1) -and $before.call -ceq $labels[$index] -and $after.call -ceq $labels[$index] -and $before.phase -ceq 'beforeOriginalExecutor' -and $after.phase -ceq 'afterOriginalExecutor'
    $valid = $valid -and (($after.facts | ConvertTo-Json -Depth 8 -Compress) -ceq ($call | ConvertTo-Json -Depth 8 -Compress))
    if ($valid) { $callsValid++ } else { $complete = $false }
  }
}
$inputsStable = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -eq $selection.testBinarySha256 -and (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -eq $selection.fixtureSha256 -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -eq $scriptHash
$complete = $complete -and $pairsValid -eq 5 -and $callsValid -eq 5 -and $inputsStable
[ordered]@{
  head = $head
  test = $test
  case = $case
  startedAtUtc = $started
  finishedAtUtc = $finished
  exitCode = $testExit
  summaryCount = $summaries.Count
  finalSummary = if ($last) { $last.Value } else { $null }
  oneObservationTestPassed = $oneObservationTestPassed
  diagnosticObservationComplete = $complete
  pairedObjectsValidated = $pairsValid
  fixedCallsValidated = $callsValid
  markerRecords = $trace.Count
  observation = $observation
  inputsStable = $inputsStable
  testBinarySha256 = $selection.testBinarySha256
  fixtureSha256 = $selection.fixtureSha256
  validatorScriptSha256 = $scriptHash
  separateDiagnosticCaseCount = 1
  separateDiagnosticFixedCallCount = 5
  carrier149Acceptance = $false
  existingLaunchFailureFixed = $false
  readContextAdmissionProven = $false
  productOrAllWindowsComplete = $false
  stdoutSha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash
  stderrSha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $raw 'git-known-config.result.json') -Encoding utf8
Get-Content -LiteralPath $stdout
Get-Content -LiteralPath $stderr
Get-Content -LiteralPath (Join-Path $raw 'git-known-config.result.json')
if (-not $complete) { if ($testExit -ne 0) { exit $testExit }; exit 1 }
exit 0
