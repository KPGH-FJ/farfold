param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead)
$ErrorActionPreference = 'Stop'
$raw = Join-Path $PWD 'windows-diagnostics-raw'
New-Item -ItemType Directory -Path $raw -ErrorAction Stop | Out-Null
function Inputs {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead) { throw 'Focused recovery source head changed' }
  $paths = @(& git ls-files -- 'src-tauri/src' 'src-tauri/native' 'src-tauri/examples' 'src-tauri/Cargo.toml' 'src-tauri/Cargo.lock' 'src-tauri/build.rs' 'src-tauri/*.json' 'src-tauri/*.manifest' '.github/scripts/windows-capability-closeout*' '.github/scripts/windows-recovery-followup*' '.github/scripts/windows-null-attributes-cases.json' '.github/scripts/windows-native-loader-diagnostics.ps1' '.github/workflows/windows-recovery-followup.yml' | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 100) { throw 'Focused recovery source inputs incomplete' }
  $map = [ordered]@{}
  foreach ($path in $paths) { $map[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  return $map
}
$before = Inputs
$before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'inputs-before.json') -Encoding utf8
[ordered]@{ sourceHead = $ExpectedHead; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; scope = 'focused follow-up to actual d513 failures; original 140 manifest and separate legacy 27 unchanged; not whole-cohort acceptance' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $raw 'identity.json') -Encoding utf8
& cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json 1> (Join-Path $raw 'test-build.stdout.jsonl') 2> (Join-Path $raw 'test-build.stderr.log')
$testBuildExit = $LASTEXITCODE
if ($testBuildExit -ne 0) { Get-Content -LiteralPath (Join-Path $raw 'test-build.stderr.log'); exit $testBuildExit }
$executables = @(Get-Content -LiteralPath (Join-Path $raw 'test-build.stdout.jsonl') | ForEach-Object {
  $message = $_ | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ($message.reason -eq 'compiler-artifact' -and $message.target.name -eq 'farfold_lib' -and $message.profile.test -eq $true -and $message.executable) { $message.executable }
} | Select-Object -Unique)
if ($executables.Count -ne 1) { throw 'Focused recovery requires exactly one libtest binary' }
$binary = (Resolve-Path -LiteralPath $executables[0] -ErrorAction Stop).Path
$deps = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/deps')) + [IO.Path]::DirectorySeparatorChar
if (-not $binary.StartsWith($deps, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($binary) -ne '.exe') { throw 'Unexpected focused test binary location' }
& cargo build --manifest-path src-tauri/Cargo.toml --locked --example windows_process_fixture 1> (Join-Path $raw 'fixture-build.stdout.log') 2> (Join-Path $raw 'fixture-build.stderr.log')
$fixtureBuildExit = $LASTEXITCODE
if ($fixtureBuildExit -ne 0) { Get-Content -LiteralPath (Join-Path $raw 'fixture-build.stderr.log'); exit $fixtureBuildExit }
$fixture = (Resolve-Path -LiteralPath 'src-tauri/target/debug/examples/windows_process_fixture.exe' -ErrorAction Stop).Path
$after = Inputs
$after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $raw 'inputs-after.json') -Encoding utf8
if (($before | ConvertTo-Json -Compress) -cne ($after | ConvertTo-Json -Compress)) { throw 'Focused recovery build inputs changed' }
[ordered]@{
  sourceHead = $ExpectedHead; testBinary = $binary; testBinarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
  fixture = $fixture; fixtureSha256 = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
  testBuildExit = $testBuildExit; fixtureBuildExit = $fixtureBuildExit; sourceInputsStable = $true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $raw 'build-selection.json') -Encoding utf8
