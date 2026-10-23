param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead)
$ErrorActionPreference = 'Stop'
$case = 'browser_sharing::windows_native_screenshot_tests::real_windows_public_screenshot_keeps_permission_pixels_and_retirement'
$raw = Join-Path $PWD 'windows-p27-native-raw'
New-Item -ItemType Directory -Path $raw -ErrorAction Stop | Out-Null
function Write-Record($Name, $Value) {
  $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $raw $Name) -Encoding utf8
}
function Source-Inputs {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedHead) { throw 'Native P27 source head changed' }
  # Exact tracked crate inputs include case-sensitive native/BrowserWorkspace.*,
  # embedded JS, common Rust dependencies, resources, icons and Cargo/config.
  # Generated target and untracked user/history material are not traversed.
  $paths = @(& git ls-files -- 'src-tauri' '.github/scripts/windows-p27-native.ps1' '.github/scripts/windows-native-loader-diagnostics.ps1' '.github/scripts/windows-pe-resource-inspection.py' '.github/scripts/windows-helper-stdin-controls.py' '.github/scripts/windows-helper-stdin-cases.json' '.github/workflows/windows-p27-native.yml' | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 20) { throw 'Native P27 source input selection incomplete' }
  $map = [ordered]@{}
  foreach ($path in $paths) { $map[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  return $map
}
$before = Source-Inputs
Write-Record 'inputs-before.json' $before
Write-Record 'identity.json' ([ordered]@{ sourceHead = $ExpectedHead; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; exactCase = $case; scope = 'actual Wry/WebView2 controlled public HTTPS fixture and production permission/capture/helper path; no Agent or installed-product claim' })
& cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json 1> (Join-Path $raw 'test-build.stdout.jsonl') 2> (Join-Path $raw 'test-build.stderr.log')
if ($LASTEXITCODE -ne 0) { throw 'Native P27 libtest build failed; no execution' }
$executables = @(Get-Content -LiteralPath (Join-Path $raw 'test-build.stdout.jsonl') | ForEach-Object {
  $message = $_ | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ($message.reason -eq 'compiler-artifact' -and $message.target.name -eq 'farfold_lib' -and $message.profile.test -eq $true -and $message.executable) { $message.executable }
} | Select-Object -Unique)
if ($executables.Count -ne 1) { throw 'Native P27 requires exactly one libtest binary' }
$binary = (Resolve-Path -LiteralPath $executables[0] -ErrorAction Stop).Path
$deps = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/deps')) + [IO.Path]::DirectorySeparatorChar
if (-not $binary.StartsWith($deps, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($binary) -ne '.exe') { throw 'Unexpected native test binary location' }
& cargo build --manifest-path src-tauri/Cargo.toml --locked --bin farfold --message-format=json 1> (Join-Path $raw 'helper-build.stdout.log') 2> (Join-Path $raw 'helper-build.stderr.log')
if ($LASTEXITCODE -ne 0) { throw 'Same-source production helper build failed; no execution' }
$helper = (Resolve-Path -LiteralPath 'src-tauri/target/debug/farfold.exe' -ErrorAction Stop).Path
$library = $null
$librarySha = $null
$libraryError = $null
$debug = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug')) + [IO.Path]::DirectorySeparatorChar
try {
  $libraries = @(Get-Content -LiteralPath (Join-Path $raw 'helper-build.stdout.log') | ForEach-Object {
    $message = $_ | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    if ($message.reason -eq 'compiler-artifact' -and $message.target.name -eq 'farfold_lib' -and $message.target.crate_types -contains 'cdylib' -and $message.profile.test -eq $false) {
      @($message.filenames | Where-Object { [IO.Path]::GetExtension($_) -ieq '.dll' })
    }
  } | Select-Object -Unique)
  if ($libraries.Count -ne 1) { throw 'Expected one same-build desktop library' }
  $selectedLibrary = (Resolve-Path -LiteralPath $libraries[0] -ErrorAction Stop).Path
  if (-not $selectedLibrary.StartsWith($debug, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($selectedLibrary) -ine 'farfold_lib.dll') { throw 'Unexpected desktop library location' }
  $library = $selectedLibrary
  $librarySha = (Get-FileHash -LiteralPath $library -Algorithm SHA256).Hash.ToLowerInvariant()
} catch { $library = $null; $librarySha = $null; $libraryError = $_.Exception.Message }
$binarySha = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
$helperSha = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Record 'build-selection.json' ([ordered]@{ sourceHead = $ExpectedHead; testBinary = $binary; testBinarySha256 = $binarySha; helperBinary = $helper; helperBinarySha256 = $helperSha; cdylibExpected = $true; cdylibBinary = $library; cdylibBinarySha256 = $librarySha; cdylibSelectionError = $libraryError; helperScope = 'only original --farfold-browser-mcp-helper entry, never application run()' })
# Preserve the selected build before the first executable launch. A loader exit,
# a missing exact FQN and an unsettled list process are different observations.
$listInfo = [Diagnostics.ProcessStartInfo]::new()
$listInfo.FileName = $binary
$listInfo.WorkingDirectory = $PWD.Path
$listInfo.UseShellExecute = $false
$listInfo.RedirectStandardOutput = $true
$listInfo.RedirectStandardError = $true
foreach ($argument in @($case, '--ignored', '--exact', '--list')) { [void]$listInfo.ArgumentList.Add($argument) }
$listProcess = [Diagnostics.Process]::new()
$listProcess.StartInfo = $listInfo
$listStdout = [IO.File]::Create((Join-Path $raw 'list.stdout.log'))
$listStderr = [IO.File]::Create((Join-Path $raw 'list.stderr.log'))
$listPid = $null
$listNatural = $false
$listTimedOut = $false
$listSettled = $false
$listExitCode = $null
$listStartError = $null
$listTerminationSettled = $null
try {
  if (-not $listProcess.Start()) { throw 'Native list process did not start' }
  $listPid = $listProcess.Id
  $listOutTask = $listProcess.StandardOutput.BaseStream.CopyToAsync($listStdout)
  $listErrTask = $listProcess.StandardError.BaseStream.CopyToAsync($listStderr)
  if ($listProcess.WaitForExit(15000)) { $listNatural = $true; $listExitCode = $listProcess.ExitCode }
  else {
    $listTimedOut = $true
    try { $listProcess.Kill() } catch { }
    $listTerminationSettled = $listProcess.WaitForExit(5000)
  }
  $listOutSettled = $listOutTask.Wait(5000)
  $listErrSettled = $listErrTask.Wait(5000)
  $listSettled = $listOutSettled -and $listErrSettled
} catch {
  $listCause = $_.Exception.GetBaseException()
  $listStartError = [ordered]@{ type = $listCause.GetType().FullName; nativeCode = if ($listCause -is [ComponentModel.Win32Exception]) { $listCause.NativeErrorCode } else { $null } }
} finally {
  $listStdout.Dispose()
  $listStderr.Dispose()
  $listProcess.Dispose()
}
$listOutFile = Get-Item -LiteralPath (Join-Path $raw 'list.stdout.log')
$listErrFile = Get-Item -LiteralPath (Join-Path $raw 'list.stderr.log')
$listWithinBound = $listOutFile.Length -le 65536 -and $listErrFile.Length -le 65536
$listed = if ($listSettled -and $listWithinBound) { @(Get-Content -LiteralPath $listOutFile.FullName) } else { @() }
$listExactMatches = @($listed | Where-Object { $_ -ceq "${case}: test" }).Count
$listInputsStable = $false
$listInputError = $null
try {
  $afterList = Source-Inputs
  Write-Record 'inputs-after-list.json' $afterList
  $listInputsStable = ($before | ConvertTo-Json -Compress) -ceq ($afterList | ConvertTo-Json -Compress)
} catch { $listInputError = $_.Exception.GetType().FullName }
$listPassed = $listNatural -and -not $listTimedOut -and $listSettled -and $listExitCode -eq 0 -and $listWithinBound -and $listExactMatches -eq 1 -and $listInputsStable -and $null -eq $listStartError
$listClassification = if ($listPassed) { 'exact-test-listed' } elseif ($listStartError) { 'process-start-or-output-error' } elseif ($listTimedOut) { 'list-timeout' } elseif (-not $listNatural -or -not $listSettled) { 'list-unsettled' } elseif ($listExitCode -ne 0) { 'native-list-exit-failed' } elseif (-not $listWithinBound) { 'list-output-over-bound' } elseif (-not $listInputsStable) { 'source-input-changed-or-unverified' } else { 'exact-list-mismatch' }
Write-Record 'list-execution.json' ([ordered]@{ sourceHead = $ExpectedHead; exactCase = $case; testBinarySha256 = $binarySha; originalListPid = $listPid; arguments = @($case, '--ignored', '--exact', '--list'); naturalCompletionObserved = $listNatural; timedOut = $listTimedOut; exitCode = $listExitCode; exitCodeHex = if ($null -ne $listExitCode) { '0x{0:X8}' -f ([uint32]([int64]$listExitCode -band 0xffffffffL)) } else { $null }; startOrOutputError = $listStartError; terminationSettled = $listTerminationSettled; outputSettled = $listSettled; outputWithinReadBound = $listWithinBound; stdoutBytes = $listOutFile.Length; stderrBytes = $listErrFile.Length; stdoutSha256 = (Get-FileHash -LiteralPath $listOutFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); stderrSha256 = (Get-FileHash -LiteralPath $listErrFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); exactNameMatches = $listExactMatches; inputsStable = $listInputsStable; inputCheckError = $listInputError; classification = $listClassification; passed = $listPassed })
if (-not $listPassed) { throw 'Native P27 executable list failed or exact inventory unverified; see list-execution.json and original list logs' }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $binary
$info.WorkingDirectory = $PWD.Path
$info.UseShellExecute = $false
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($argument in @($case, '--ignored', '--exact', '--nocapture', '--test-threads=1')) { [void]$info.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$stdout = [IO.File]::Create((Join-Path $raw 'native.stdout.log'))
$stderr = [IO.File]::Create((Join-Path $raw 'native.stderr.log'))
$timedOut = $false
$natural = $false
$exitCode = $null
try {
  if (-not $process.Start()) { throw 'Native P27 process did not start' }
  $pidObserved = $process.Id
  $outTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
  $errTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
  if ($process.WaitForExit(240000)) { $natural = $true; $exitCode = $process.ExitCode }
  else {
    $timedOut = $true
    # This is the original held Process object, not a later PID lookup. Timeout
    # remains incomplete; it cannot prove child cleanup or a successful test.
    try { $process.Kill() } catch { }
    [void]$process.WaitForExit(15000)
  }
  if (-not $outTask.Wait(15000) -or -not $errTask.Wait(15000)) { throw 'Native output did not settle' }
} finally {
  $stdout.Dispose()
  $stderr.Dispose()
  $process.Dispose()
}
$after = Source-Inputs
Write-Record 'inputs-after.json' $after
$stable = ($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress)
$stdoutFile = Get-Item -LiteralPath (Join-Path $raw 'native.stdout.log')
$stderrFile = Get-Item -LiteralPath (Join-Path $raw 'native.stderr.log')
if ($stdoutFile.Length -gt 1048576 -or $stderrFile.Length -gt 1048576) { throw 'Native diagnostic output exceeded its evidence read bound' }
$out = Get-Content -LiteralPath $stdoutFile.FullName -Raw
$err = Get-Content -LiteralPath $stderrFile.FullName -Raw
$records = @($err -split "`r?`n" | Where-Object { $_.StartsWith('FARFOLD_P27_NATIVE_COMPLETED ') })
$record = $null
if ($records.Count -eq 1) { $record = $records[0].Substring('FARFOLD_P27_NATIVE_COMPLETED '.Length) | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
$expectedChecks = @('actual-permitted-PNG-center', 'text-grant-does-not-authorize-screenshot', 'denial-preserves-text', 'closed', 'design', 'frame', 'same-scope-revoked-at-actual-capture-callback')
$checksExact = $null -ne $record -and (($record.checks | ConvertTo-Json -Compress) -ceq ($expectedChecks | ConvertTo-Json -Compress))
$passed = $natural -and -not $timedOut -and $exitCode -eq 0 -and $stable -and $records.Count -eq 1 -and $checksExact -and $out.Contains('1 passed; 0 failed; 0 ignored') -and $record.helper.binarySha256 -ceq $helperSha -and $record.helper.naturalExit -eq 0 -and $record.cleanupAcknowledged -eq $true -and $record.native.actualCallbackRevocations -eq 1 -and $record.native.revokedCallbackHadPng -eq $true -and -not [string]::IsNullOrWhiteSpace($record.native.runtimeVersion)
Write-Record 'execution.json' ([ordered]@{ sourceHead = $ExpectedHead; exactCase = $case; originalTestPid = $pidObserved; naturalCompletionObserved = $natural; timedOut = $timedOut; exitCode = $exitCode; inputsStable = $stable; completedRecordCount = $records.Count; checksExact = $checksExact; actual = $record; passed = $passed; limits = 'controlled WebResourceRequested HTTPS fixture; real Wry/HWND/STA/WebView2/CDP/pixels/permission/helper ACK. Not remote-site TLS, installed UI, real Agent receipt, dynamic DOM mutation completeness or every platform.' })
if (-not $passed) { throw 'Actual native P27 conditions or controls incomplete/failed; see original logs and receipt' }
