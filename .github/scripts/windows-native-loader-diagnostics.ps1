param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
  [Parameter(Mandatory = $true)][string]$RawDirectory,
  [ValidateSet('ReadOnly', 'P27ManifestControl')][string]$Mode = 'ReadOnly'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This is diagnostic evidence only. It never rewrites the original executable,
# repairs DLL search paths, loads a DLL, or marks any capability test as passed.
$case = 'browser_sharing::windows_native_screenshot_tests::real_windows_public_screenshot_keeps_permission_pixels_and_retirement'
$clock = [Diagnostics.Stopwatch]::StartNew()
$calls = [Collections.Generic.List[object]]::new()
$script:capturedCharacters = 0L
$output = $null
$binary = $null
$originalHash = $null
$helper = $null
$helperHash = $null
$dumpbin = $null
$mt = $null
$copyDirectory = $null
$report = [ordered]@{
  sourceHead = $ExpectedHead; mode = $Mode; completed = $false; diagnosticOnly = $true
  originalTestResultModified = $false; formalCasePassCount = 0
  limits = [ordered]@{ totalSeconds = 240; toolSeconds = 15; charactersPerStream = 1048576; totalCharacters = 16777216; directModules = 48; candidateFilesPerModule = 2 }
  unknowns = @('Static candidate files are not proof of actual Windows loader resolution.', 'API-set mapping, SxS selection, forwarded exports, ordinal imports and transitive dependencies remain unproven.')
  manifestControl = [ordered]@{ attempted = $false; reason = 'not-requested'; formalAcceptance = $false }
}
function Assert-Budget {
  if ($clock.Elapsed.TotalSeconds -ge 240) { throw 'Diagnostic global time bound reached' }
}
function Hash-File([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Write-Record([string]$Name, $Value) {
  $Value | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $output $Name) -Encoding utf8
}
function Read-SmallJson([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.Length -gt 65536 -or $item.PSIsContainer) { throw 'Diagnostic input record exceeds bound' }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop)
}
function Assert-OrdinaryFile([string]$Path, [long]$Limit) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -gt $Limit -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected diagnostic input file' }
  return $item
}
function Find-Tool([string]$Name, [string[]]$Patterns) {
  $paths = @($Patterns | ForEach-Object { Get-Item -Path $_ -ErrorAction SilentlyContinue } | Sort-Object FullName -Descending)
  if ($paths.Count -eq 0) { throw "Preinstalled Microsoft tool unavailable: $Name" }
  $item = Assert-OrdinaryFile $paths[0].FullName 67108864
  $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw "Preinstalled tool signature unverified: $Name" }
  return [ordered]@{ path = $item.FullName; sha256 = Hash-File $item.FullName; fileVersion = $item.VersionInfo.FileVersion; signatureStatus = [string]$signature.Status; signer = $signature.SignerCertificate.Subject }
}
function Invoke-Bounded([string]$Name, [string]$Executable, [string[]]$Arguments) {
  Assert-Budget
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable
  $info.WorkingDirectory = $PWD.Path
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $record = [ordered]@{ name = $Name; executable = $Executable; arguments = $Arguments; pid = $null; naturalCompletion = $false; exitCode = $null; exitCodeHex = $null; abortReason = $null; terminationSettled = $null; streamsSettled = $false; error = $null }
  $streams = @()
  try {
    if (-not $process.Start()) { throw 'Diagnostic process did not start' }
    $record.pid = $process.Id
    foreach ($reader in @($process.StandardOutput, $process.StandardError)) {
      $buffer = [char[]]::new(4096)
      $streams += @{ reader = $reader; buffer = $buffer; text = [Text.StringBuilder]::new(); task = $reader.ReadAsync($buffer, 0, $buffer.Length); ended = $false }
    }
    while ($true) {
      foreach ($stream in $streams) {
        if (-not $stream.ended -and $stream.task.IsCompleted) {
          $count = $stream.task.GetAwaiter().GetResult()
          if ($count -eq 0) { $stream.ended = $true }
          elseif ($stream.text.Length + $count -gt 1048576 -or $script:capturedCharacters + $count -gt 16777216) { $record.abortReason = 'output-bound'; break }
          else {
            [void]$stream.text.Append($stream.buffer, 0, $count)
            $script:capturedCharacters += $count
            $stream.task = $stream.reader.ReadAsync($stream.buffer, 0, $stream.buffer.Length)
          }
        }
      }
      if ($record.abortReason) { break }
      if ($process.HasExited -and $streams[0].ended -and $streams[1].ended) {
        $record.naturalCompletion = $true
        $record.streamsSettled = $true
        $record.exitCode = $process.ExitCode
        $record.exitCodeHex = '0x{0:X8}' -f ([uint32]([int64]$process.ExitCode -band 0xffffffffL))
        break
      }
      if ($watch.Elapsed.TotalSeconds -ge 15) { $record.abortReason = 'process-or-stream-timeout'; break }
      if ($clock.Elapsed.TotalSeconds -ge 240) { $record.abortReason = 'global-time-bound'; break }
      Start-Sleep -Milliseconds 5
    }
  } catch { $record.error = $_.Exception.GetType().FullName }
  finally {
    if ($null -ne $record.pid -and -not $record.naturalCompletion) {
      try { if (-not $process.HasExited) { $process.Kill() }; $record.terminationSettled = $process.WaitForExit(2000) }
      catch { $record.terminationSettled = $false }
    }
    foreach ($stream in $streams) { $stream.reader.Dispose() }
    $process.Dispose()
    $record.elapsedMilliseconds = $watch.ElapsedMilliseconds
    $outText = if ($streams.Count -gt 0) { $streams[0].text.ToString() } else { '' }
    $errText = if ($streams.Count -gt 1) { $streams[1].text.ToString() } else { '' }
    $record.stdout = "$Name.stdout.log"
    $record.stderr = "$Name.stderr.log"
    [IO.File]::WriteAllText((Join-Path $output $record.stdout), $outText, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $output $record.stderr), $errText, [Text.UTF8Encoding]::new($false))
    $record.stdoutSha256 = Hash-File (Join-Path $output $record.stdout)
    $record.stderrSha256 = Hash-File (Join-Path $output $record.stderr)
    $calls.Add($record)
    Write-Record "$Name.execution.json" $record
  }
  return $record
}
function Require-Success($Record) {
  if (-not $Record.naturalCompletion -or -not $Record.streamsSettled -or $Record.exitCode -ne 0 -or $Record.error) { throw "Diagnostic tool incomplete or failed: $($Record.name)" }
}
function Read-Output($Record) { return [IO.File]::ReadAllText((Join-Path $output $Record.stdout)) }
function Parse-Imports([string]$Text) {
  $modules = [Collections.Generic.List[object]]::new()
  $current = $null
  $kind = 'normal'
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '^\s*Section contains the following delay load imports:') { $kind = 'delay'; $current = $null; continue }
    if ($line -match '^\s*Summary\s*$') { $current = $null; continue }
    if ($line -match '^\s+([A-Za-z0-9_.-]+\.dll)\s*$') {
      $current = [ordered]@{ module = $Matches[1]; kind = $kind; names = [Collections.Generic.List[string]]::new(); unresolvedOrdinalRows = [Collections.Generic.List[string]]::new() }
      $modules.Add($current)
    } elseif ($null -ne $current -and $line -match '^\s+[0-9A-Fa-f]{1,8}\s+([A-Za-z_?@$][^\s]*)\s*$') {
      $current.names.Add($Matches[1])
    } elseif ($null -ne $current -and $line -match '(?i)ordinal\s+[0-9]+') { $current.unresolvedOrdinalRows.Add($line.Trim()) }
  }
  return @($modules.ToArray())
}
function Read-Manifest([string]$Path) {
  [void](Assert-OrdinaryFile $Path 65536)
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $settings.MaxCharactersInDocument = 65536
  $reader = [Xml.XmlReader]::Create($Path, $settings)
  try { $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($reader); return ,$document }
  finally { $reader.Dispose() }
}
function Has-CommonControls6($Document) {
  return @($Document.SelectNodes("//*[local-name()='assemblyIdentity' and namespace-uri()='urn:schemas-microsoft-com:asm.v1']") | Where-Object { $_.GetAttribute('name') -ceq 'Microsoft.Windows.Common-Controls' -and $_.GetAttribute('version') -ceq '6.0.0.0' }).Count -gt 0
}
function Check-HelperManifest($Document) {
  # An allowlist of the existing default Common-Controls dependency, optionally
  # explicit asInvoker/uiAccess=false. Missing elevation directive is reported
  # as absent, never described as an explicit asInvoker declaration.
  $asm = 'urn:schemas-microsoft-com:asm.v1'
  $trust = 'urn:schemas-microsoft-com:asm.v3'
  $root = $Document.DocumentElement
  if ($root.LocalName -cne 'assembly' -or $root.NamespaceURI -cne $asm -or $root.GetAttribute('manifestVersion') -cne '1.0') { throw 'Helper manifest root not allowed' }
  $allowed = @{
    assembly = @('manifestVersion'); dependency = @(); dependentAssembly = @()
    assemblyIdentity = @('type', 'name', 'version', 'processorArchitecture', 'publicKeyToken', 'language')
    trustInfo = @(); security = @(); requestedPrivileges = @(); requestedExecutionLevel = @('level', 'uiAccess')
  }
  $counts = @{}
  foreach ($element in $Document.SelectNodes('//*')) {
    $name = $element.LocalName
    if (-not $allowed.ContainsKey($name)) { throw 'Helper manifest contains an additional declaration' }
    $expectedNamespace = if ($name -in @('trustInfo', 'security', 'requestedPrivileges', 'requestedExecutionLevel')) { $trust } else { $asm }
    if ($element.NamespaceURI -cne $expectedNamespace) { throw 'Helper manifest namespace not allowed' }
    foreach ($attribute in $element.Attributes) {
      if ($attribute.NamespaceURI -ceq 'http://www.w3.org/2000/xmlns/') { continue }
      if ($attribute.NamespaceURI -ne '' -or $attribute.Name -cnotin $allowed[$name]) { throw 'Helper manifest attribute not allowed' }
    }
    if (-not $counts.ContainsKey($name)) { $counts[$name] = 0 }
    $counts[$name]++
    $parent = $element.ParentNode.LocalName
    $expectedParent = switch ($name) { 'assembly' { '#document' }; 'dependency' { 'assembly' }; 'dependentAssembly' { 'dependency' }; 'assemblyIdentity' { 'dependentAssembly' }; 'trustInfo' { 'assembly' }; 'security' { 'trustInfo' }; 'requestedPrivileges' { 'security' }; 'requestedExecutionLevel' { 'requestedPrivileges' } }
    if ($parent -cne $expectedParent) { throw 'Helper manifest hierarchy not allowed' }
  }
  foreach ($name in @('assembly', 'dependency', 'dependentAssembly', 'assemblyIdentity')) { if (-not $counts.ContainsKey($name) -or $counts[$name] -ne 1) { throw 'Helper manifest dependency count not allowed' } }
  $identity = $Document.SelectSingleNode("//*[local-name()='assemblyIdentity']")
  if ($identity.GetAttribute('type') -cne 'win32' -or $identity.GetAttribute('name') -cne 'Microsoft.Windows.Common-Controls' -or $identity.GetAttribute('version') -cne '6.0.0.0' -or $identity.GetAttribute('publicKeyToken') -cne '6595b64144ccf1df' -or $identity.GetAttribute('processorArchitecture') -cnotin @('*', 'amd64') -or $identity.GetAttribute('language') -cne '*') { throw 'Helper manifest dependency identity not allowed' }
  $level = $Document.SelectSingleNode("//*[local-name()='requestedExecutionLevel']")
  foreach ($name in @('trustInfo', 'security', 'requestedPrivileges', 'requestedExecutionLevel')) {
    $expectedCount = if ($null -eq $level) { 0 } else { 1 }
    $actualCount = if ($counts.ContainsKey($name)) { $counts[$name] } else { 0 }
    if ($actualCount -ne $expectedCount) { throw 'Helper manifest privilege hierarchy not allowed' }
  }
  if ($null -ne $level -and ($level.GetAttribute('level') -cne 'asInvoker' -or $level.GetAttribute('uiAccess') -cne 'false')) { throw 'Helper manifest would request additional privileges' }
  foreach ($textNode in $Document.SelectNodes('//text()')) { if (-not [string]::IsNullOrWhiteSpace($textNode.Value)) { throw 'Unexpected helper manifest text' } }
  if ($Document.SelectNodes('//processing-instruction()').Count -ne 0) { throw 'Unexpected helper manifest processing instruction' }
  return [ordered]@{ allowed = $true; dependency = 'Microsoft.Windows.Common-Controls 6.0.0.0'; requestedExecutionLevel = if ($null -eq $level) { 'absent-no-elevation-directive' } else { 'asInvoker'; }; uiAccess = if ($null -eq $level) { $null } else { $false } }
}
try {
  if (-not $IsWindows) { throw 'Native loader evidence requires the original Windows runner' }
  $raw = (Resolve-Path -LiteralPath $RawDirectory -ErrorAction Stop).Path
  $workspace = [IO.Path]::GetFullPath($PWD.Path).TrimEnd('\') + '\'
  if (-not $raw.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) { throw 'Raw directory must be inside the current workspace' }
  $newOutput = Join-Path $raw 'loader-diagnostics'
  if (Test-Path -LiteralPath $newOutput) { throw 'Diagnostic output already exists; refusing overwrite or duplicate control' }
  New-Item -ItemType Directory -Path $newOutput -ErrorAction Stop | Out-Null
  $output = $newOutput
  $selectionPath = Join-Path $raw 'build-selection.json'
  $selection = Read-SmallJson $selectionPath
  if ($selection.sourceHead -cne $ExpectedHead) { throw 'Selected executable belongs to a different source head' }
  $binary = (Resolve-Path -LiteralPath $selection.testBinary -ErrorAction Stop).Path
  $deps = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/deps')).TrimEnd('\') + '\'
  if ([IO.Path]::GetDirectoryName($binary) + '\' -ine $deps -or [IO.Path]::GetFileName($binary) -cnotmatch '^farfold_lib-[0-9a-f]+\.exe$') { throw 'Unexpected original libtest path' }
  $binaryInfo = Assert-OrdinaryFile $binary 2147483648
  $originalHash = Hash-File $binary
  if ($selection.testBinarySha256 -notmatch '^[a-fA-F0-9]{64}$' -or $originalHash -ine $selection.testBinarySha256) { throw 'Original libtest hash differs from selected build' }
  $report.buildSelectionSha256 = Hash-File $selectionPath
  $report.original = [ordered]@{ path = $binary; sha256 = $originalHash; bytes = $binaryInfo.Length }
  $vsPatterns = @((Join-Path $env:ProgramFiles 'Microsoft Visual Studio/2022/*/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/2022/*/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe'))
  $dumpbin = Find-Tool 'dumpbin' $vsPatterns
  $mt = Find-Tool 'mt' @((Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin/*/x64/mt.exe'))
  $report.tools = [ordered]@{ dumpbin = $dumpbin; mt = $mt }
  $importsCall = Invoke-Bounded 'original-imports' $dumpbin.path @('/NOLOGO', '/IMPORTS', $binary)
  Require-Success $importsCall
  $dependentsCall = Invoke-Bounded 'original-dependents' $dumpbin.path @('/NOLOGO', '/DEPENDENTS', $binary)
  Require-Success $dependentsCall
  $headersCall = Invoke-Bounded 'original-headers' $dumpbin.path @('/NOLOGO', '/HEADERS', $binary)
  Require-Success $headersCall
  $imports = @(Parse-Imports (Read-Output $importsCall))
  if ($imports.Count -eq 0 -or $imports.Count -gt 48) { throw 'Direct import inventory empty, unparsed or over bound' }
  $report.directImports = $imports
  $originalManifest = Join-Path $output 'original.manifest.xml'
  $manifestCall = Invoke-Bounded 'original-manifest' $mt.path @('-nologo', "-inputresource:$binary;#1", "-out:$originalManifest")
  if (-not $manifestCall.naturalCompletion -or -not $manifestCall.streamsSettled -or $manifestCall.error) { throw 'Original manifest extraction did not settle' }
  $noResourceDirectory = (Read-Output $headersCall) -cmatch '(?m)^\s*0+\s+\[\s*0+\]\s+RVA \[size\] of Resource Directory\s*$'
  $originalLacksV6 = $false
  if ($manifestCall.naturalCompletion -and $manifestCall.exitCode -eq 0 -and (Test-Path -LiteralPath $originalManifest)) {
    $document = Read-Manifest $originalManifest
    $hasV6 = Has-CommonControls6 $document
    $originalLacksV6 = -not $hasV6
    $report.originalManifest = [ordered]@{ status = 'extracted'; sha256 = Hash-File $originalManifest; commonControls6 = $hasV6 }
  } elseif ($manifestCall.naturalCompletion -and $manifestCall.exitCode -ne 0 -and $noResourceDirectory) {
    $originalLacksV6 = $true
    $report.originalManifest = [ordered]@{ status = 'absent-resource-directory-zero'; commonControls6 = $false }
  } else { $report.originalManifest = [ordered]@{ status = 'unknown-extraction-failed'; commonControls6 = $null } }
  $candidates = [Collections.Generic.List[object]]::new()
  $moduleIndex = 0
  foreach ($module in $imports) {
    Assert-Budget
    $moduleIndex++
    if ($module.module -match '^(?i:api-ms-|ext-ms-)') {
      $candidates.Add([ordered]@{ module = $module.module; status = 'api-set-resolution-unknown' }); continue
    }
    $paths = @((Join-Path ([IO.Path]::GetDirectoryName($binary)) $module.module), (Join-Path ([Environment]::SystemDirectory) $module.module))
    $candidateIndex = 0
    $found = $false
    foreach ($path in $paths) {
      $candidateIndex++
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $found = $true
      $item = Assert-OrdinaryFile $path 268435456
      $hashBefore = Hash-File $path
      $exportsCall = Invoke-Bounded ("exports-{0:D2}-{1}" -f $moduleIndex, $candidateIndex) $dumpbin.path @('/NOLOGO', '/EXPORTS', $path)
      Require-Success $exportsCall
      $text = Read-Output $exportsCall
      $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
      $forwarded = [Collections.Generic.List[string]]::new()
      foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{1,16}\s+(\S+)') {
          [void]$names.Add($Matches[1])
          if ($line -match '\s=\s\S+') { $forwarded.Add($line.Trim()) }
        }
        elseif ($line -match '^\s+\d+\s+[0-9A-Fa-f]+\s+(\S+)\s+=\s+\S+') { [void]$names.Add($Matches[1]); $forwarded.Add($line.Trim()) }
        elseif ($line -match '^\s+\d+\s+[0-9A-Fa-f]+\s+(\S+)\s+\(forwarded to [^)]+\)\s*$') { [void]$names.Add($Matches[1]); $forwarded.Add($line.Trim()) }
      }
      if ($hashBefore -cne (Hash-File $path)) { throw 'DLL candidate changed during static read' }
      $exportsRecognized = $names.Count -gt 0 -and $text -match 'ordinal\s+hint\s+RVA\s+name'
      $missing = if ($exportsRecognized) { @($module.names | Where-Object { -not $names.Contains($_) }) } else { @() }
      $candidates.Add([ordered]@{ module = $module.module; importKind = $module.kind; path = $path; sha256 = $hashBefore; bytes = $item.Length; fileVersion = $item.VersionInfo.FileVersion; exportsRecognized = $exportsRecognized; namedExportCount = $names.Count; missingNamedImportsInThisCandidateOnly = $missing; forwardedExportRows = @($forwarded.ToArray()); actualLoaderSelection = 'unknown-not-inferred-from-path'; exportsReceipt = "$($exportsCall.name).execution.json" })
    }
    if (-not $found) { $candidates.Add([ordered]@{ module = $module.module; status = 'not-in-two-candidate-directories-loader-resolution-unknown' }) }
  }
  $report.dllCandidates = @($candidates.ToArray())
  if ($Mode -eq 'P27ManifestControl') {
    $control = $report.manifestControl
    $control.reason = 'eligibility-not-established'
    $listPath = Join-Path $raw 'list-execution.json'
    if (-not (Test-Path -LiteralPath $listPath)) { $control.reason = 'original-list-receipt-missing' }
    else {
      $list = Read-SmallJson $listPath
      $control.originalListReceiptSha256 = Hash-File $listPath
      $taskDialog = @($imports | Where-Object { $_.module -ieq 'COMCTL32.dll' -and $_.kind -ceq 'normal' -and $_.names.Contains('TaskDialogIndirect') }).Count -gt 0
      $eligible = $list.sourceHead -ceq $ExpectedHead -and $list.testBinarySha256 -ieq $originalHash -and $list.exactCase -ceq $case -and $list.exitCodeHex -ceq '0xC0000139' -and $list.naturalCompletionObserved -eq $true -and $list.timedOut -eq $false -and $list.outputSettled -eq $true -and $list.outputWithinReadBound -eq $true -and $list.inputsStable -eq $true -and $list.exactNameMatches -eq 0 -and $null -eq $list.startOrOutputError -and $taskDialog -and $originalLacksV6
      $control.eligibility = [ordered]@{ originalEntryPointFailureReceiptMatches = $eligible; taskDialogIndirectNormalImport = $taskDialog; originalLacksCommonControls6 = $originalLacksV6 }
      if (-not $eligible) { $control.reason = 'fixed-original-failure-or-manifest-import-conditions-not-established' }
      else {
        $helper = (Resolve-Path -LiteralPath $selection.helperBinary -ErrorAction Stop).Path
        $expectedHelper = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/debug/farfold.exe'))
        if ($helper -ine $expectedHelper) { throw 'Unexpected production helper path' }
        [void](Assert-OrdinaryFile $helper 2147483648)
        $helperHash = Hash-File $helper
        if ($selection.helperBinarySha256 -notmatch '^[0-9A-Fa-f]{64}$' -or $helperHash -ine $selection.helperBinarySha256) { throw 'Production helper differs from selected build' }
        $helperManifest = Join-Path $output 'helper.manifest.xml'
        $helperCall = Invoke-Bounded 'helper-manifest' $mt.path @('-nologo', "-inputresource:$helper;#1", "-out:$helperManifest")
        Require-Success $helperCall
        $helperDocument = Read-Manifest $helperManifest
        $helperPolicy = Check-HelperManifest $helperDocument
        $control.helper = [ordered]@{ path = $helper; sha256 = $helperHash; manifestSha256 = Hash-File $helperManifest; policy = $helperPolicy }
        # Moving the copy must not silently remove a local-DLL/sidecar input.
        $localDlls = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($binary)) -Filter '*.dll' -File | Select-Object -First 1)
        if ($localDlls.Count -ne 0 -or (Test-Path -LiteralPath "$binary.manifest") -or (Test-Path -LiteralPath "$binary.local")) { throw 'Copy control would change a local DLL or sidecar search input' }
        Assert-Budget
        $tempRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP -ErrorAction Stop).Path
        $copyDirectory = Join-Path $tempRoot ("farfold-loader-manifest-control-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $copyDirectory -ErrorAction Stop | Out-Null
        $copy = Join-Path $copyDirectory ([IO.Path]::GetFileName($binary))
        [IO.File]::Copy($binary, $copy, $false)
        if ((Hash-File $copy) -cne $originalHash) { throw 'Diagnostic copy was not byte-identical before manifest embedding' }
        $control.copyBeforeSha256 = $originalHash
        $control.copyPath = $copy
        $embedCall = Invoke-Bounded 'copy-embed-manifest' $mt.path @('-nologo', '-manifest', $helperManifest, "-outputresource:$copy;#1")
        Require-Success $embedCall
        $control.copyAfterSha256 = Hash-File $copy
        $copyImports = Invoke-Bounded 'copy-imports' $dumpbin.path @('/NOLOGO', '/IMPORTS', $copy)
        Require-Success $copyImports
        $sameImports = ($imports | ConvertTo-Json -Depth 8 -Compress) -ceq (@(Parse-Imports (Read-Output $copyImports)) | ConvertTo-Json -Depth 8 -Compress)
        if (-not $sameImports) { throw 'Diagnostic copy import inventory changed' }
        $copyManifest = Join-Path $output 'copy.manifest.xml'
        $copyManifestCall = Invoke-Bounded 'copy-manifest' $mt.path @('-nologo', "-inputresource:$copy;#1", "-out:$copyManifest")
        Require-Success $copyManifestCall
        $copyDocument = Read-Manifest $copyManifest
        [void](Check-HelperManifest $copyDocument)
        if ($copyDocument.DocumentElement.OuterXml -cne $helperDocument.DocumentElement.OuterXml) { throw 'Copy manifest differs from the extracted helper manifest' }
        $control.copyManifestSha256 = Hash-File $copyManifest
        if ((Hash-File $helper) -cne $helperHash -or (Hash-File $binary) -cne $originalHash) { throw 'Original source executables changed before control' }
        $control.attempted = $true
        $control.reason = 'fixed-copy-only-list-control'
        $copyList = Invoke-Bounded 'copy-list' $copy @($case, '--ignored', '--exact', '--list')
        $copyProcessSettled = $copyList.naturalCompletion -or $copyList.terminationSettled -eq $true
        $exactCount = @((Read-Output $copyList) -split "`r?`n" | Where-Object { $_ -ceq "${case}: test" }).Count
        $control.listReceipt = 'copy-list.execution.json'
        $control.exactNameMatches = $exactCount
        $control.copyListStartedSuccessfully = $copyList.naturalCompletion -and $copyList.streamsSettled -and $copyList.exitCode -eq 0 -and $exactCount -eq 1
        $control.interpretation = 'Only a manifest-copy loader contrast. No test body, production screenshot, recovery or original executable acceptance is established.'
        if (-not $copyProcessSettled -or $copyList.abortReason -or $copyList.error) { throw 'Copy list diagnostic incomplete; original failure remains' }
      }
    }
  }
  $report.completed = $true
} catch {
  $report.error = [ordered]@{ type = $_.Exception.GetType().FullName; message = $_.Exception.Message }
} finally {
  if ($null -ne $binary -and $null -ne $originalHash) {
    try { $report.originalHashAfter = Hash-File $binary; $report.originalUnchanged = $report.originalHashAfter -ceq $originalHash; if (-not $report.originalUnchanged) { $report.completed = $false } }
    catch { $report.originalUnchanged = $false; $report.completed = $false }
  }
  if ($null -ne $helper -and $null -ne $helperHash) {
    try { $report.helperHashAfter = Hash-File $helper; $report.helperUnchanged = $report.helperHashAfter -ceq $helperHash; if (-not $report.helperUnchanged) { $report.completed = $false } }
    catch { $report.helperUnchanged = $false; $report.completed = $false }
  }
  foreach ($tool in @($dumpbin, $mt)) {
    if ($null -ne $tool) {
      try { $tool.unchanged = (Hash-File $tool.path) -ceq $tool.sha256; if (-not $tool.unchanged) { $report.completed = $false } }
      catch { $tool.unchanged = $false; $report.completed = $false }
    }
  }
  if ($null -ne $copyDirectory) {
    # Do not race an uncertain diagnostic tool with directory deletion. This
    # dedicated RUNNER_TEMP directory is excluded from artifact upload and is
    # left to the hosted runner's normal job cleanup, even after success.
    $report.copyDirectory = $copyDirectory
    $report.copyCleanup = 'retained-for-runner-job-cleanup'
  }
  $report.elapsedMilliseconds = $clock.ElapsedMilliseconds
  $report.calls = @($calls.ToArray())
  if ($null -ne $output -and (Test-Path -LiteralPath $output -PathType Container)) { Write-Record 'summary.json' $report }
}
if (-not $report.completed) { throw 'Native loader diagnosis incomplete or failed; original evidence and diagnostic summary retained' }
