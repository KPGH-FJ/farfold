param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
  [Parameter(Mandatory = $true)][ValidateSet('Build', 'Install')][string]$Phase
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$raw = Join-Path $PWD 'windows-install-raw'
# Literal equivalent of the engineering collector's admitted production inputs.
$releaseScopes = @('src/', 'assets/', 'public/', 'scripts/', 'patches/', '.cargo/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/', 'src-tauri/.cargo/', '.github/', 'src-tauri/examples/')
$releaseRootPattern = '(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|index\.html|tsconfig[^/]*\.json|[^/]+\.config\.[^/]+|\.npmrc|\.pnpmfile\.cjs|src-tauri/[^/]+\.(rs|json|toml|lock|plist))'
$ownHook = 'src-tauri/native/windows-installer-hooks.nsh'
$controller = '.github/scripts/windows-install-owned.py'
$sharedApi = '.github/scripts/windows-job-query-observer.py'
$officialUtils = 'b27b407f886cca738e44e774f15e6b556b43ce52557a7c8891ee4eca7dd8013d'

function Write-Record([string]$Name, $Value) {
  $path = Join-Path $raw $Name
  if (Test-Path -LiteralPath $path) { throw "Receipt already exists: $Name" }
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding utf8
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Plain-Path([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path is not an owned ordinary target' }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -ceq $current) { break }
    $current = $parent
  }
}
function Source-Inputs([switch]$CaptureChanged) {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead) { throw 'Installation source head changed' }
  $tracked = @(& git ls-files)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate the fixed source' }
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($parent in @($PWD.Path, (Join-Path $PWD 'src-tauri'))) {
    foreach ($item in @(Get-ChildItem -LiteralPath $parent -Force)) {
      $name = $item.FullName.Substring($PWD.Path.Length + 1).Replace('\', '/')
      if ([regex]::IsMatch($name, ('^(?:' + $releaseRootPattern + ')$'))) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release root input is a reparse point' }
        if (-not $item.PSIsContainer) { [void]$names.Add($name) }
      }
    }
  }
  foreach ($scope in $releaseScopes) {
    $base = Join-Path $PWD $scope
    if (-not (Test-Path -LiteralPath $base)) { continue }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($base)
    while ($pending.Count) {
      $directory = $pending.Pop()
      if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release input directory is a reparse point' }
      foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release input is a reparse point' }
        if ($item.PSIsContainer) { if ($item.Name -cne '__pycache__') { $pending.Push($item.FullName) } }
        elseif ($item.Name -cne '.DS_Store') { [void]$names.Add($item.FullName.Substring($PWD.Path.Length + 1).Replace('\', '/')) }
      }
    }
  }
  $paths = @($names | Sort-Object)
  if ($paths.Count -lt 100) { throw 'Release input map is incomplete' }
  if (-not $CaptureChanged) {
    if (@($paths | Where-Object { $_ -cnotin $tracked }).Count) { throw 'Untracked release inputs cannot be attributed to the fixed source' }
    # This hosted fresh checkout must match HEAD, including tracked deletions.
    # Do not expand thousands of input names past the Windows argv limit.
    & git diff --quiet --no-ext-diff HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Installation inputs differ from fixed source' }
  }
  $map = [ordered]@{}
  foreach ($path in $paths) {
    $map[$path] = if (Test-Path -LiteralPath $path -PathType Leaf) { Hash $path } else { $null }
  }
  foreach ($path in @($ownHook, $controller, $sharedApi, '.github/scripts/windows-install-lifecycle.ps1', '.github/workflows/windows.yml', 'src-tauri/resources/release-manifest.json')) {
    if (-not $map.Contains($path)) { throw "Release input missing: $path" }
  }
  if (@($map.Keys | Where-Object { $_ -like 'src-tauri/icons/*' }).Count -eq 0) { throw 'Release icons were not mapped' }
  return $map
}
function Equal-Inputs($Left, $Right) {
  if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
  foreach ($key in $Left.Keys) { if (-not $Right.Contains($key) -or $Left[$key] -cne $Right[$key]) { return $false } }
  return $true
}
function Configuration {
  $base = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json -AsHashtable
  $platform = Get-Content -LiteralPath 'src-tauri/tauri.windows.conf.json' -Raw | ConvertFrom-Json -AsHashtable
  $package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json -AsHashtable
  $windows = $platform.bundle.windows
  $nsis = $windows.nsis
  if ($base.identifier -cne 'ai.farfold.desktop' -or $base.productName -cne 'Farfold' -or $windows.allowDowngrades -ne $false -or $nsis.installMode -cne 'currentUser' -or $windows.webviewInstallMode.type -cne 'downloadBootstrapper' -or $package.devDependencies['@tauri-apps/cli'] -cne '2.11.4') { throw 'Unreviewed installation configuration' }
  $hookPath = [IO.Path]::GetFullPath((Join-Path 'src-tauri' $nsis.installerHooks))
  if ($hookPath -cne [IO.Path]::GetFullPath($ownHook) -or $nsis.template -or $base.bundle.externalBin -or $base.bundle.fileAssociations -or $base.plugins['deep-link'] -or $base.bundle.useLocalToolsDir) { throw 'Only the reviewed owned hook and package surface are allowed' }
  if ($base.bundle.resources.Count -ne 1 -or $base.bundle.resources['resources/release-manifest.json'] -cne 'release-manifest.json') { throw 'Unreviewed packaged resources' }
  Plain-Path $hookPath
  return $base
}
function Canonical($Value) {
  if ($Value -is [Collections.IDictionary]) {
    $out = [ordered]@{}
    foreach ($key in @($Value.Keys | Sort-Object)) { $out[$key] = Canonical $Value[$key] }
    return $out
  }
  if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) { return ,@($Value | ForEach-Object { Canonical $_ }) }
  return $Value
}
function Same-State($Left, $Right) { (Canonical $Left | ConvertTo-Json -Compress -Depth 20) -ceq (Canonical $Right | ConvertTo-Json -Compress -Depth 20) }

if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows') { throw 'This installer lifecycle runs only in the declared Windows hosted job' }

if ($Phase -ceq 'Build') {
  if (Test-Path -LiteralPath $raw) { throw 'Installation evidence directory already exists' }
  New-Item -ItemType Directory -Path $raw | Out-Null
  $before = $null; $after = $null; $buildExit = $null; $failure = $null; $selection = $null
  $started = [DateTime]::UtcNow.ToString('o')
  try {
    $before = Source-Inputs
    Write-Record 'inputs-before.json' $before
    $config = Configuration
    & corepack pnpm tauri build --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis -- --locked 1> (Join-Path $raw 'build.stdout.log') 2> (Join-Path $raw 'build.stderr.log')
    $buildExit = [int]$LASTEXITCODE
    if ($buildExit -ne 0) { throw 'NSIS build did not return naturally with zero' }
    $release = Join-Path $PWD 'src-tauri/target/x86_64-pc-windows-msvc/release'
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $release 'bundle/nsis') -Filter '*-setup.exe' -File)
    $scripts = @(Get-Item -LiteralPath (Join-Path $release 'nsis/x64/installer.nsi') -ErrorAction SilentlyContinue)
    if ($installers.Count -ne 1 -or $scripts.Count -ne 1) { throw 'One installer and its actual generated NSIS input are required' }
    $nsi = $scripts[0]; $utils = Join-Path $nsi.DirectoryName 'utils.nsh'
    if (-not (Test-Path -LiteralPath $utils -PathType Leaf)) { throw 'Actual NSIS helper input unavailable; installation remains untested' }
    $nsiText = [IO.File]::ReadAllText($nsi.FullName)
    $utilsText = [IO.File]::ReadAllText($utils).Replace("`r`n", "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    $canonicalUtilsHash = [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($utilsText))).ToLowerInvariant()
    $sha.Dispose()
    if ($canonicalUtilsHash -cne $officialUtils) { throw 'Generated helper differs from the reviewed official version' }
    $defs = [ordered]@{}
    foreach ($match in [regex]::Matches($nsiText, '(?m)^!define\s+([A-Z0-9_]+)\s+"([^"]*)"\s*$')) { $defs[$match.Groups[1].Value] = $match.Groups[2].Value }
    if ($defs.INSTALLMODE -cne 'currentUser' -or $defs.BUNDLEID -cne $config.identifier -or $defs.PRODUCTNAME -cne $config.productName -or $defs.VERSION -cne $config.version -or $defs.MAINBINARYNAME -cne 'farfold' -or $defs.ARCH -cne 'x64' -or $defs.INSTALLWEBVIEW2MODE -cne 'downloadBootstrapper' -or $defs.STARTMENUFOLDER -or $defs.MANUFACTURER -notmatch '^[A-Za-z0-9 ._-]{1,80}$') { throw 'Generated installer context is outside the reviewed scope' }
    $hookMatch = [regex]::Match($nsiText, '(?m)^!include "([^"\r\n]*windows-installer-hooks\.nsh)"\s*$')
    if (-not $hookMatch.Success -or [IO.Path]::GetFullPath($hookMatch.Groups[1].Value.Replace('\\', '\')) -cne [IO.Path]::GetFullPath($ownHook)) { throw 'Generated installer did not include the owned hook' }
    if ($nsiText -notmatch '(?s)Function \.onInstSuccess.*GetOptions.*"/R".*RunAsUser.*FunctionEnd') { throw 'Generated no-autostart guard is not recognized' }
    if ($env:NSISDIR -or $env:NSISCONFDIR) { throw 'Unreviewed NSIS directory/config overrides prevent safe preprocessing' }
    $compiler = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'tauri/NSIS/makensis.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Actual NSIS compiler unavailable for safe preprocessing' }
    Plain-Path $compiler
    Push-Location $nsi.DirectoryName
    try { & $compiler /SAFEPPO /NOCONFIG /INPUTCHARSET UTF8 /OUTPUTCHARSET UTF8 $nsi.FullName 1> (Join-Path $raw 'nsis-preprocessed.nsi') 2> (Join-Path $raw 'nsis-preprocess.stderr.log'); $preprocessExit = [int]$LASTEXITCODE } finally { Pop-Location }
    if ($preprocessExit -ne 0 -or [IO.File]::ReadAllText((Join-Path $raw 'nsis-preprocessed.nsi')) -match '(?im)^\s*nsis_tauri_utils::KillProcess(?:CurrentUser)?\b') { throw 'Preprocessed installer retains a kill call or preprocessing failed' }
    Copy-Item -LiteralPath $nsi.FullName -Destination (Join-Path $raw 'generated-installer.nsi')
    Copy-Item -LiteralPath $utils -Destination (Join-Path $raw 'generated-utils.nsh')
    $main = Join-Path $release 'farfold.exe'
    Plain-Path $main; Plain-Path $installers[0].FullName
    $selection = [ordered]@{ sourceHead = $ExpectedHead; scope = 'InstallLifecycle'; identifier = $config.identifier; version = $config.version; installer = $installers[0].FullName; installerSha256 = Hash $installers[0].FullName; mainImage = $main; mainImageSha256 = Hash $main; generatedNsiSha256 = Hash $nsi.FullName; generatedUtilsSha256 = Hash $utils; canonicalOfficialUtilsSha256 = $canonicalUtilsHash; hookSha256 = Hash $ownHook; compilerSha256 = Hash $compiler; preprocessNaturalExitCode = $preprocessExit; preprocessedSha256 = Hash (Join-Path $raw 'nsis-preprocessed.nsi'); definitions = $defs }
  } catch { $failure = $_.Exception.Message } finally {
    try { $after = Source-Inputs -CaptureChanged; Write-Record 'inputs-after.json' $after } catch { $failure = $_.Exception.Message }
    $stable = Equal-Inputs $before $after
    if (-not $stable) { $failure = 'Release inputs changed or could not be captured' }
    if ($selection -and -not $failure) { $selection['inputsBeforeSha256'] = Hash (Join-Path $raw 'inputs-before.json'); $selection['inputsAfterSha256'] = Hash (Join-Path $raw 'inputs-after.json'); $selection['sharedApiSha256'] = $after[$sharedApi]; Write-Record 'build-selection.json' $selection }
    Write-Record 'build.result.json' ([ordered]@{ sourceHead = $ExpectedHead; scope = 'InstallLifecycle'; command = @('corepack', 'pnpm', 'tauri', 'build', '--ci', '--no-sign', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--', '--locked'); startedAtUtc = $started; finishedAtUtc = [DateTime]::UtcNow.ToString('o'); naturalBuildExitCode = $buildExit; sourceInputsStable = $stable; failure = $failure; passed = $null -eq $failure -and $buildExit -eq 0; AppLaunchRequested = $false })
    foreach ($name in @('build.stdout.log', 'build.stderr.log')) { $path = Join-Path $raw $name; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path } }
  }
  if ($failure) { throw $failure }
  exit 0
}

$selectionPath = Join-Path $raw 'build-selection.json'
$selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json -AsHashtable
$inputsPath = Join-Path $raw 'inputs-after.json'
$expectedInputs = Get-Content -LiteralPath $inputsPath -Raw | ConvertFrom-Json -AsHashtable
function Confirm-Selection {
  if ($selection.sourceHead -cne $ExpectedHead -or $selection.scope -cne 'InstallLifecycle' -or (Hash $inputsPath) -cne $selection.inputsAfterSha256 -or (Hash $selection.installer) -cne $selection.installerSha256 -or (Hash $ownHook) -cne $selection.hookSha256 -or -not (Equal-Inputs (Source-Inputs) $expectedInputs)) { throw 'Installation candidate source or bytes changed' }
}
function Reg-State([Microsoft.Win32.RegistryHive]$Hive, [Microsoft.Win32.RegistryView]$View, [string]$Key) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
  try {
    $item = $root.OpenSubKey($Key, $false)
    if ($null -eq $item) { return $null }
    try {
      $state = [ordered]@{}
      foreach ($name in @('', 'DisplayName', 'Publisher', 'DisplayVersion', 'InstallLocation', 'UninstallString', 'MainBinaryName', 'Installer Language')) { if ($item.GetValueNames() -contains $name) { $state[$name] = $item.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } }
      return $state
    } finally { $item.Dispose() }
  } finally { $root.Dispose() }
}
function Reg-Value([Microsoft.Win32.RegistryHive]$Hive, [Microsoft.Win32.RegistryView]$View, [string]$Key, [string]$Name) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
  try { $item = $root.OpenSubKey($Key, $false); if ($null -eq $item) { return $null }; try { return $item.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $item.Dispose() } } finally { $root.Dispose() }
}
function Assert-NoPriorArp {
  foreach ($hive in @('CurrentUser', 'LocalMachine')) { foreach ($view in @('Registry64', 'Registry32')) {
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $items = $root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
      if ($null -eq $items) { continue }
      try {
        foreach ($name in $items.GetSubKeyNames()) {
          $item = $items.OpenSubKey($name, $false)
          if ($null -eq $item) { throw 'An uninstall record could not be read completely' }
          try { if ([string]$item.GetValue('DisplayName') -ieq 'Farfold') { throw 'Prior matching installation, including legacy WiX, must be preserved' } } finally { $item.Dispose() }
        }
      } finally { $items.Dispose() }
    } finally { $root.Dispose() }
  } }
}
function WebView-State {
  $guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $pv = Reg-Value LocalMachine Registry64 "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid" 'pv'
  $source = 'HKLM64/WOW6432Node'
  if (-not $pv) { $pv = Reg-Value CurrentUser Registry64 "SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid" 'pv'; $source = 'HKCU64' }
  $version = $null
  if (-not $pv -or -not [Version]::TryParse([string]$pv, [ref]$version)) { throw 'WebView2 not already registered: no dependency installation is allowed' }
  if ($selection.definitions.MINIMUMWEBVIEW2VERSION -and $version -lt [Version]$selection.definitions.MINIMUMWEBVIEW2VERSION) { throw 'Existing WebView2 is older than the actual installer minimum' }
  $candidates = @()
  foreach ($base in @([Environment]::GetFolderPath('ProgramFilesX86'), [Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('LocalApplicationData'))) {
    $path = Join-Path $base "Microsoft/EdgeWebView/Application/$pv/msedgewebview2.exe"
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Plain-Path $path
      $fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion
      if ($fileVersion -match '^([0-9]+(?:\.[0-9]+){3})' -and [Version]$Matches[1] -eq $version) { $candidates += [ordered]@{ path = $path; fileVersion = $fileVersion } }
    }
  }
  if (-not $candidates.Count) { throw 'Registered WebView2 has no corresponding existing runtime file' }
  $bootstrapper = Join-Path ([IO.Path]::GetTempPath()) 'MicrosoftEdgeWebview2Setup.exe'
  if (Test-Path -LiteralPath $bootstrapper) { throw 'Dependency bootstrapper path is not fresh; it will not be deleted' }
  return [ordered]@{ registrySource = $source; pv = $pv; runtimeFiles = $candidates; bootstrapperPath = $bootstrapper; bootstrapperAbsent = $true }
}
function Assert-NoApp($Fixture = $null) {
  $processes = @([Diagnostics.Process]::GetProcessesByName('farfold'))
  foreach ($process in $processes) {
    try {
      if ($null -eq $Fixture -or $process.Id -ne $Fixture.pid -or $process.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $Fixture.creationTime -or $process.MainModule.FileName -ine $fixtureExe) { throw 'An existing App or unknown same-name process prevents this installation check' }
    } finally { $process.Dispose() }
  }
  if ($Fixture -and $processes.Count -ne 1) { throw 'Owned console fixture is not the only same-name process' }
}
function File-State([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  Plain-Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer) { return [ordered]@{ directory = $true } }
  return [ordered]@{ bytes = $item.Length; sha256 = Hash $Path }
}
function Link-State([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  Plain-Path $Path
  $shell = New-Object -ComObject WScript.Shell
  $properties = New-Object -ComObject Shell.Application
  $link = $null; $folder = $null; $item = $null
  try {
    $link = $shell.CreateShortcut($Path)
    $folder = $properties.NameSpace([IO.Path]::GetDirectoryName($Path))
    if ($null -eq $folder) { throw 'Shortcut property folder unavailable' }
    $item = $folder.ParseName([IO.Path]::GetFileName($Path))
    if ($null -eq $item) { throw 'Shortcut property item unavailable' }
    return [ordered]@{ target = $link.TargetPath; arguments = $link.Arguments; appUserModelId = $item.ExtendedProperty('System.AppUserModel.ID'); sha256 = Hash $Path }
  } finally {
    foreach ($object in @($item, $folder, $link, $properties, $shell)) { if ($null -ne $object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($object) } }
  }
}

$failure = $null; $fixtureProcess = $null; $sentinels = @(); $webBefore = $null
$started = [DateTime]::UtcNow.ToString('o')
try {
  Confirm-Selection
  $config = Configuration
  $taskRoot = Join-Path $env:RUNNER_TEMP ("farfold-install-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)-$([Guid]::NewGuid().ToString('N'))")
  $installDir = Join-Path $taskRoot 'app with spaces'; $fixtureDir = Join-Path $taskRoot 'fixture'; $fixtureExe = Join-Path $fixtureDir 'farfold.exe'
  $roaming = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $config.identifier
  $local = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier
  $arp = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Farfold'
  $memory = "Software\$($selection.definitions.MANUFACTURER)\Farfold"
  $desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Farfold.lnk'
  $startLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Farfold.lnk'
  foreach ($path in @($taskRoot, $roaming, $local, $desktop, $startLink, (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Farfold'))) { Plain-Path $path; if (Test-Path -LiteralPath $path) { throw 'Preexisting installation, data or shortcut: this check will not touch it' } }
  foreach ($hive in @('CurrentUser', 'LocalMachine')) { foreach ($view in @('Registry64', 'Registry32')) {
    if ($null -ne (Reg-State $hive $view $arp) -or $null -ne (Reg-State $hive $view $memory) -or $null -ne (Reg-State $hive $view 'Software\Classes\AppUserModelId\ai.farfold.desktop')) { throw 'Preexisting Farfold registration prevents the fresh installation check' }
  } }
  Assert-NoPriorArp
  foreach ($view in @('Registry64', 'Registry32')) { if ($null -ne (Reg-Value CurrentUser $view 'Software\Microsoft\Windows\CurrentVersion\Run' 'Farfold')) { throw 'Preexisting startup value must be preserved' } }
  Assert-NoApp
  $webBefore = WebView-State
  Write-Record 'preflight.json' ([ordered]@{ sourceHead = $ExpectedHead; taskRoot = $taskRoot; installDirectory = $installDir; normalUserProfile = [Environment]::GetFolderPath('UserProfile'); roaming = $roaming; local = $local; webView = $webBefore; fresh = $true; AppStarted = $false })
  New-Item -ItemType Directory -Path $taskRoot | Out-Null
  $python = (Get-Command python.exe -CommandType Application -ErrorAction Stop).Source
  function Invoke-Owned([string]$Name, [string]$Kind, [string]$Executable, [int]$ExpectedExit = 0, [int]$Seconds = 180) {
    Confirm-Selection
    $output = Join-Path $raw $Name
    & $python -B $controller --phase $Kind --executable $Executable --install-dir $installDir --exe-sha256 (Hash $Executable) --shared-sha256 $selection.sharedApiSha256 --timeout $Seconds --expected-exit $ExpectedExit --output $output
    $exit = [int]$LASTEXITCODE
    $result = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
    if ($exit -ne 0 -or $result.passed -ne $true -or $result.naturalExitCode -ne $ExpectedExit -or $result.forced -ne $false -or $result.terminalProof -ne $true -or $result.handlesClosed -ne $true) { throw "Owned $Name did not return the exact natural result and complete process proof" }
    if (-not (Same-State (WebView-State) $webBefore)) { throw 'WebView state changed or a dependency bootstrapper appeared' }
  }
  Invoke-Owned 'install' 'install' $selection.installer
  $main = Join-Path $installDir 'farfold.exe'; $uninstaller = Join-Path $installDir 'uninstall.exe'
  if ((Hash $main) -cne $selection.mainImageSha256 -or -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Installed image does not match the actual post-bundle image' }
  if ((Hash (Join-Path $installDir 'release-manifest.json')) -cne $expectedInputs['src-tauri/resources/release-manifest.json']) { throw 'Installed resource does not match the mapped package resource' }
  $uninstallerHash = Hash $uninstaller
  $registration = Reg-State CurrentUser Registry64 $arp
  if ($registration.MainBinaryName -cne 'farfold.exe' -or $registration.DisplayVersion -cne $config.version -or $registration.InstallLocation -cne "`"$installDir`"" -or $registration.UninstallString -cne "`"$uninstaller`"") { throw 'Per-user registration points outside the owned installation' }
  foreach ($path in @($desktop, $startLink)) { $link = Link-State $path; if ($null -eq $link -or $link.target -ine $main -or $link.arguments -or $link.appUserModelId -cne $config.identifier) { throw 'Owned shortcut does not target only the installed image and identifier' } }
  Assert-NoApp
  foreach ($directory in @($roaming, $local)) {
    if (Test-Path -LiteralPath $directory) { throw 'Unexpected product data initialization before App launch' }
    New-Item -ItemType Directory -Path $directory | Out-Null
    $path = Join-Path $directory ("install-retention-$([Guid]::NewGuid().ToString('N')).txt")
    [IO.File]::WriteAllText($path, "Farfold owned non-secret retention sentinel`nrun=$($env:GITHUB_RUN_ID)`nhead=$ExpectedHead`n", [Text.UTF8Encoding]::new($false))
    $sentinels += [ordered]@{ path = $path; sha256 = Hash $path }
  }
  Write-Record 'sentinel-seed.json' $sentinels
  function State-Snapshot {
    $files = [ordered]@{}
    foreach ($file in @(Get-ChildItem -LiteralPath $installDir -Recurse -File | Sort-Object FullName)) { $files[$file.FullName.Substring($installDir.Length)] = File-State $file.FullName }
    $registry = [ordered]@{}
    foreach ($hive in @('CurrentUser', 'LocalMachine')) { foreach ($view in @('Registry64', 'Registry32')) {
      $registry["$hive/$view"] = [ordered]@{ arp = Reg-State $hive $view $arp; memory = Reg-State $hive $view $memory; aumid = Reg-State $hive $view 'Software\Classes\AppUserModelId\ai.farfold.desktop' }
    } }
    return [ordered]@{ files = $files; registry = $registry; desktop = Link-State $desktop; start = Link-State $startLink; sentinels = @($sentinels | ForEach-Object { File-State $_.path }) }
  }
  $beforeBlocked = State-Snapshot
  foreach ($view in @('Registry64', 'Registry32')) {
    $machine = $beforeBlocked.registry["LocalMachine/$view"]
    if ($null -ne $machine.arp -or $null -ne $machine.memory -or $null -ne $machine.aumid) { throw 'Per-user install wrote a machine-wide product registration' }
  }
  Write-Record 'installed-state.json' $beforeBlocked
  New-Item -ItemType Directory -Path $fixtureDir | Out-Null
  $fixtureCode = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class FarfoldInstallerOwnedFixture {
  public static int Main(string[] args) {
    if(args.Length!=2) return 21;
    Process process=Process.GetCurrentProcess();
    string temporary=args[0]+".tmp";
    File.WriteAllText(temporary, "{\"kind\":\"FARFOLD_OWNED_INSTALL_FIXTURE_V1\",\"pid\":"+process.Id+",\"creationTime\":"+process.StartTime.ToUniversalTime().ToFileTimeUtc()+"}");
    File.Move(temporary,args[0]);
    Stopwatch clock=Stopwatch.StartNew();
    while(clock.Elapsed.TotalSeconds<150) { if(File.Exists(args[1])) return 0; Thread.Sleep(25); }
    return 22;
  }
}
'@
  $fixtureSource = Join-Path $raw 'owned-console-fixture.cs'
  [IO.File]::WriteAllText($fixtureSource, $fixtureCode, [Text.UTF8Encoding]::new($false))
  $csc = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'Existing framework compiler for the non-App fixture is unavailable' }
  & $csc /nologo /target:exe /platform:x64 "/out:$fixtureExe" $fixtureSource 1> (Join-Path $raw 'fixture-build.stdout.log') 2> (Join-Path $raw 'fixture-build.stderr.log')
  $fixtureBuildExit = [int]$LASTEXITCODE
  if ($fixtureBuildExit -ne 0) { throw 'Owned console fixture did not compile' }
  $fixtureOutput = Join-Path $raw 'fixture-owner'
  $info = [Diagnostics.ProcessStartInfo]::new(); $info.FileName = $python; $info.UseShellExecute = $false
  foreach ($arg in @('-B', $controller, '--phase', 'fixture', '--executable', $fixtureExe, '--install-dir', $installDir, '--exe-sha256', (Hash $fixtureExe), '--shared-sha256', $selection.sharedApiSha256, '--timeout', '180', '--output', $fixtureOutput)) { $info.ArgumentList.Add([string]$arg) }
  $fixtureProcess = [Diagnostics.Process]::Start($info)
  $readyPath = Join-Path $fixtureDir 'ready.json'
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $readyPath) -and [DateTime]::UtcNow -lt $deadline -and -not $fixtureProcess.HasExited) { Start-Sleep -Milliseconds 25 }
  $fixture = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
  if ($fixture.kind -cne 'FARFOLD_OWNED_INSTALL_FIXTURE_V1') { throw 'Fixture identity was not published' }
  Write-Record 'fixture-selection.json' ([ordered]@{ compilerExit = $fixtureBuildExit; compiler = $csc; compilerSha256 = Hash $csc; sourceSha256 = Hash $fixtureSource; imageSha256 = Hash $fixtureExe; ready = $fixture })
  foreach ($negative in @(@{ name = 'install-refused'; kind = 'install'; exe = $selection.installer }, @{ name = 'uninstall-refused'; kind = 'uninstall'; exe = $uninstaller })) {
    Assert-NoApp $fixture
    Invoke-Owned $negative.name $negative.kind $negative.exe 2 30
    Assert-NoApp $fixture
    $afterBlocked = State-Snapshot
    Write-Record ($negative.name + '-state.json') $afterBlocked
    if (-not (Same-State $beforeBlocked $afterBlocked)) { throw 'Refused operation mutated owned installation or retained data' }
  }
  [IO.File]::WriteAllText((Join-Path $fixtureDir 'stop.signal'), 'owned fixture stop')
  if (-not $fixtureProcess.WaitForExit(30000) -or $fixtureProcess.ExitCode -ne 0) { throw 'Owned fixture did not finish naturally' }
  $fixtureResult = Get-Content -LiteralPath (Join-Path $fixtureOutput 'result.json') -Raw | ConvertFrom-Json
  if ($fixtureResult.passed -ne $true -or $fixtureResult.controlledConsoleFixture -ne $true -or $fixtureResult.naturalExitCode -ne 0) { throw 'Fixture ownership/exit proof failed' }
  Assert-NoApp
  Invoke-Owned 'uninstall' 'uninstall' $uninstaller
  $controllerCleanup = [ordered]@{ usedNoSelfCopyOption = $true; uninstallerDeletedByController = $false; emptyInstallDirectoryDeletedByController = $false }
  if (Test-Path -LiteralPath $main) { throw 'Uninstaller did not remove the main image' }
  if (Test-Path -LiteralPath $uninstaller) {
    Plain-Path $uninstaller
    if ((Hash $uninstaller) -cne $uninstallerHash) { throw 'Residual uninstaller bytes changed; it will not be deleted' }
    Remove-Item -LiteralPath $uninstaller -Force
    $controllerCleanup.uninstallerDeletedByController = $true
  }
  if (Test-Path -LiteralPath $installDir) { Plain-Path $installDir; [IO.Directory]::Delete($installDir, $false); $controllerCleanup.emptyInstallDirectoryDeletedByController = $true }
  Write-Record 'controller-cleanup.json' $controllerCleanup
  $finalRegistry = [ordered]@{}
  foreach ($hive in @('CurrentUser', 'LocalMachine')) { foreach ($view in @('Registry64', 'Registry32')) {
    $values = [ordered]@{ arp = Reg-State $hive $view $arp; memory = Reg-State $hive $view $memory; aumid = Reg-State $hive $view 'Software\Classes\AppUserModelId\ai.farfold.desktop' }
    $finalRegistry["$hive/$view"] = $values
    if ($null -ne $values.arp -or $null -ne $values.aumid -or ($hive -ceq 'LocalMachine' -and $null -ne $values.memory)) { throw 'Unexpected product registry state after uninstall' }
    if ($hive -ceq 'CurrentUser' -and -not (Same-State $values.memory $beforeBlocked.registry["$hive/$view"].memory)) { throw 'Uninstall changed the expected retained install/language memory' }
  } }
  if ((Test-Path -LiteralPath $desktop) -or (Test-Path -LiteralPath $startLink)) { throw 'Owned shortcut remains after uninstall' }
  Write-Record 'final-registry.json' $finalRegistry
  foreach ($sentinel in $sentinels) { Plain-Path $sentinel.path; if ((Hash $sentinel.path) -cne $sentinel.sha256) { throw 'Uninstall did not preserve the exact synthetic sentinel' } }
  Assert-NoApp; Confirm-Selection
  Write-Record 'retention.json' ([ordered]@{ syntheticSentinels = $sentinels; manufacturerMemoryRetained = Reg-State CurrentUser Registry64 $memory; userDataDeletedByController = $false; currentAppOrRealAgentTested = $false })
} catch { $failure = $_.Exception.Message } finally {
  if ($fixtureProcess) {
    if (-not $fixtureProcess.HasExited) {
      try { [IO.File]::WriteAllText((Join-Path $fixtureDir 'stop.signal'), 'owned fixture stop after failure'); [void]$fixtureProcess.WaitForExit(45000) } catch {}
    }
    if (-not $fixtureProcess.HasExited) { $failure = "$failure; owned fixture controller termination remains unknown" }
    $fixtureProcess.Dispose()
  }
  Write-Record 'lifecycle.result.json' ([ordered]@{ sourceHead = $ExpectedHead; scope = 'InstallLifecycle'; startedAtUtc = $started; finishedAtUtc = [DateTime]::UtcNow.ToString('o'); failure = $failure; passed = $null -eq $failure; selectionSha256 = Hash $selectionPath; inputsAfterSha256 = $selection.inputsAfterSha256; AppOrAgentLaunchRequested = $false; AppLaunchObservation = $(if ($failure) { 'not-verified' } else { 'no-App-image-in-complete-owned-process-proofs' }); syntheticDataOnly = $true; ordinarySelfCopyUninstallTested = $false; noSelfCopyUninstallTested = $true; oldUnguardedUpgradeVerified = $false })
  $manifest = [ordered]@{}
  foreach ($file in @(Get-ChildItem -LiteralPath $raw -Recurse -File | Sort-Object FullName)) { $manifest[$file.FullName.Substring($raw.Length + 1).Replace('\', '/')] = [ordered]@{ bytes = $file.Length; sha256 = Hash $file.FullName } }
  Write-Record 'raw-manifest.json' $manifest
}
if ($failure) { throw $failure }
