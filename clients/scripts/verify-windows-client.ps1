param(
  [Parameter(Mandatory=$true)][string]$SeedInstaller,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$SeedVersion='1.0.0',
  [string]$ApplicationSourceRevision=$env:GITHUB_SHA,
  [string]$OriginalBuildRun='',
  [string]$OriginalArtifactId='',
  [string]$OriginalArtifactSha256='',
  [string]$ExpectedInstallerSha256=''
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'This verification requires an isolated native Windows GitHub Actions runner.' }
. (Join-Path $PSScriptRoot 'windows-certificate-policy.ps1')
$expected = Get-ExpectedWindowsSigningIdentity
$settings = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../shared/release-settings.json') | ConvertFrom-Json
$currentVersion = [string]$settings.version
if ($SeedVersion -ne '1.0.0' -or $currentVersion -notmatch '^\d+\.\d+\.\d+$' -or $currentVersion -eq $SeedVersion) { throw 'Unexpected Windows upgrade verification versions.' }
if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'Native verification must be bound to the checked-out source revision.' }
if ($ApplicationSourceRevision -notmatch '^[a-f0-9]{40}$') { throw 'Invalid application source revision.' }
$installerDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
if ($ApplicationSourceRevision -cne $env:GITHUB_SHA) {
  if ($OriginalBuildRun -notmatch '^https://github\.com/Brclio/Brclio-Pay/actions/runs/[0-9]+$' -or $OriginalArtifactId -notmatch '^[0-9]+$' -or $OriginalArtifactSha256 -notmatch '^[a-f0-9]{64}$' -or $ExpectedInstallerSha256 -notmatch '^[a-f0-9]{64}$' -or $installerDigest -cne $ExpectedInstallerSha256) { throw 'Separate verifier requires pinned original build and exact installer provenance.' }
}
function Write-VerificationProgress([string]$Message) { Write-Host ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Message) }
Write-VerificationProgress ('Begin native verification; application source ' + $ApplicationSourceRevision + '; verifier source ' + $env:GITHUB_SHA)
$seedDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $SeedInstaller).Hash.ToLowerInvariant()
if ($seedDigest -cne '1656c5c3c622aca87f1427f62b6e800cdefbb23650c63e23ae500de1f176c588') { throw 'Published 1.0.0 installation seed checksum mismatch.' }
$temporary = Join-Path $env:RUNNER_TEMP ('brcliopay-native-' + [guid]::NewGuid().ToString('N'))
$installation = Join-Path $temporary 'application'
$profile = Join-Path $temporary 'verification-profile'
New-Item -ItemType Directory -Force -Path $OutputDirectory,$temporary | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
if ($installation -match '\s') { throw 'The isolated NSIS verification directory must not contain spaces.' }
$executable = Join-Path $installation 'Brclio Pay.exe'
$stores = @('Cert:\CurrentUser\Root','Cert:\CurrentUser\TrustedPublisher')
foreach ($store in $stores) { if (Test-Path -LiteralPath (Join-Path $store $expected.Identity.certificateThumbprintSha1)) { throw 'The verification user already trusts this publisher; the untrusted test would not be meaningful.' } }
$addedStores = [System.Collections.Generic.List[string]]::new()
$trustOperations = [System.Collections.Generic.List[object]]::new()

# Use the documented physical registry provider in a bounded child process, only in the isolated runner's CurrentUser stores.
# https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore
function Invoke-IsolatedUserTrust {
  param([ValidateSet('Root','TrustedPublisher')][string]$Store,[ValidateSet('addstore','delstore')][string]$Operation)
  Write-VerificationProgress ('Begin bounded CurrentUser certificate operation: ' + $Operation + ' ' + $Store)
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = (Get-Process -Id $PID).Path
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'windows-user-certificate-store.ps1'),'-Store',$Store,'-Operation',$Operation)) { $info.ArgumentList.Add($argument) }
  $process = [System.Diagnostics.Process]::Start($info)
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill($true); $process.WaitForExit(); Write-Host ($stderr.GetAwaiter().GetResult()); throw 'CurrentUser certificate operation exceeded its 30 second process deadline.' }
    $output = $stdout.GetAwaiter().GetResult(); $diagnostic = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { Write-Host $diagnostic; throw ('CurrentUser certificate operation failed with exit code ' + $process.ExitCode + '.') }
    $operationEvidence = $output | ConvertFrom-Json
    if ($operationEvidence.schema -ne 1 -or $operationEvidence.scope -ne 'CurrentUser' -or $operationEvidence.provider -ne 'CryptUIWizImport_NO_UI' -or $operationEvidence.registryScope -ne 'HKCU' -or $operationEvidence.physicalProvider -ne 'CERT_STORE_PROV_REG' -or $operationEvidence.importFlags -ne '0x00030001' -or $operationEvidence.currentUserFlags -ne '0x00010000' -or $operationEvidence.physicalStorePresenceVerified -ne $true -or $operationEvidence.store -ne $Store -or $operationEvidence.operation -ne $Operation -or $operationEvidence.certificateSha256 -cne $expected.Identity.certificateSha256 -or $operationEvidence.unprotectedFlagUsed -ne $false -or $operationEvidence.globalTrustModified -ne $false) { throw 'Physical CurrentUser store operation provenance mismatch.' }
  } finally { $process.Dispose() }
  $location = 'Cert:\CurrentUser\' + $Store + '\' + $expected.Identity.certificateThumbprintSha1
  $present = Test-Path -LiteralPath $location
  # The Cert: provider may cache the earlier logical view. Physical DER persistence is asserted
  # by the child; actual native WinVerifyTrust before/after/removal determines trust, without flags.
  if ($Operation -eq 'addstore' -and $present) {
    $stored = Get-Item -LiteralPath $location
    $digest = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($stored.RawData)).ToLowerInvariant()
    if ($digest -cne $expected.Identity.certificateSha256 -or $stored.HasPrivateKey) { throw 'Isolated CurrentUser trust entry does not match the fixed public certificate.' }
  }
  Write-VerificationProgress ('Cert provider logical visibility after ' + $Operation + ' ' + $Store + ': ' + $present)
  Write-VerificationProgress ('Completed bounded CurrentUser certificate operation: ' + $Operation + ' ' + $Store)
  return [pscustomobject]@{ scope='CurrentUser'; provider='CryptUIWizImport_NO_UI'; store=$Store; operation=$Operation; verified=$true; physicalStorePresenceVerified=$true; logicalStoreVisible=$present; deadlineSeconds=30; certificateSha256=$expected.Identity.certificateSha256 }
}

function Install-Package([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'A reviewed installer is missing.' }
  $name = [IO.Path]::GetFileName($Path)
  Write-VerificationProgress ('Begin silent installation: ' + $name)
  $process = Start-Process -FilePath (Resolve-Path -LiteralPath $Path).Path -ArgumentList @('/S',"/D=$installation") -PassThru
  Write-VerificationProgress ('NSIS process started: ' + $process.Id)
  if (-not $process.WaitForExit(180000)) {
    Write-VerificationProgress ('NSIS exceeded 180 seconds: ' + $name)
    $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $process.Id -or $_.ParentProcessId -eq $process.Id } | Select-Object Name,ProcessId,ParentProcessId)
    Write-Host ($processes | ConvertTo-Json -Compress)
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    throw 'Silent NSIS installation exceeded its 180 second process deadline.'
  }
  if ($process.ExitCode -ne 0) { throw "NSIS returned exit code $($process.ExitCode)." }
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'NSIS did not install the expected executable.' }
  Write-VerificationProgress ('Completed silent installation: ' + $name)
}
function Read-Smoke([string]$Version,[string]$Label) {
  Write-VerificationProgress ('Begin packaged smoke: ' + $Version)
  $reportPath = Join-Path $OutputDirectory "$Label.json"
  $arguments = "--client-smoke-report `"$reportPath`" --client-profile `"$profile`""
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru
  $deadline = (Get-Date).AddSeconds(120)
  while (-not (Test-Path -LiteralPath $reportPath)) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited -or (Get-Date) -gt $deadline) {
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
      if (-not (Test-Path -LiteralPath $reportPath)) { throw 'Packaged Windows application did not produce its verification report.' }
    }
  }
  $process.WaitForExit(15000) | Out-Null
  if (-not $process.HasExited -or $process.ExitCode -ne 0) { throw 'Packaged Windows application failed verification.' }
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  if ($report.applicationId -ne 'cn.bornforthis.brcliopay' -or $report.appVersion -ne $Version -or $report.platform -ne 'win32' -or $report.arch -ne 'x64' -or -not $report.isPackaged) { throw 'Installed application identity does not match.' }
  foreach ($field in @('remoteNodeIsolated','remoteNativeBridgeAbsent','loginFormReady','nativeShellReady')) {
    if ($report.$field -ne $true) { throw "Native verification failed: $field." }
  }
  if ($report.httpStatus -ne 200 -or $report.pageUrl -ne 'https://pay.bornforthis.cn/admin') { throw 'Live login page was not available.' }
  Write-VerificationProgress ('Completed packaged smoke: ' + $Version)
  return $report
}

try {
  $beforeInstaller = Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus 'UntrustedRoot'
  Install-Package $SeedInstaller
  $before = Read-Smoke $SeedVersion 'windows-before-upgrade'
  $marker = Join-Path $profile 'retained-client-setting.json'
  $markerText = '{"verification":"settings-survive-upgrade"}'
  Set-Content -NoNewline -Encoding utf8 -LiteralPath $marker -Value $markerText
  Install-Package $Installer
  $after = Read-Smoke $currentVersion 'windows-after-upgrade'
  if (-not $after.verificationProfileReused -or $after.previousSmokeVersion -ne $SeedVersion -or (Get-Content -Raw -LiteralPath $marker) -ne $markerText) { throw 'Upgrade did not preserve the isolated client profile.' }
  $uninstallers = @(Get-ChildItem -LiteralPath $installation -Filter '*Uninstall*.exe' -File)
  if ($uninstallers.Count -ne 1) { throw 'Expected one signed NSIS uninstaller.' }
  $uninstaller = $uninstallers[0].FullName
  $beforeTrust = @($beforeInstaller,(Read-WindowsAuthenticodeEvidence -Path $executable -Expected $expected -RequiredStatus 'UntrustedRoot'),(Read-WindowsAuthenticodeEvidence -Path $uninstaller -Expected $expected -RequiredStatus 'UntrustedRoot'))
  foreach ($store in $stores) {
    $addedStores.Add($store)
    $trustOperations.Add((Invoke-IsolatedUserTrust -Store (Split-Path -Leaf $store) -Operation 'addstore'))
  }
  $afterTrust = @((Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus 'Valid'),(Read-WindowsAuthenticodeEvidence -Path $executable -Expected $expected -RequiredStatus 'Valid'),(Read-WindowsAuthenticodeEvidence -Path $uninstaller -Expected $expected -RequiredStatus 'Valid'))
  Write-VerificationProgress 'All three components are valid after isolated CurrentUser trust.'
  $verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
  $evidence = [ordered]@{
    schema=1; platform='win32-x64'; version=$currentVersion; sourceRevision=$ApplicationSourceRevision; applicationSourceRevision=$ApplicationSourceRevision; verifierRevision=$env:GITHUB_SHA;
    verifiedAt=$verifiedAt; nativeWindows=$true;
    installationVerified=$true; upgradeVerified=$true; profilePreserved=$true;
    liveLoginVerified=$true; remoteIsolationVerified=$true;
    installerSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant();
    commercialSignatureStatus='SelfSigned'; authenticodeStatusAfterCurrentUserTrust='Valid';
    certificateSha256=$expected.Identity.certificateSha256; publisher=$expected.Identity.publisher
  }
  $signingEvidence = [ordered]@{
    schema=1; platform='win32-x64'; version=$currentVersion; sourceRevision=$ApplicationSourceRevision; applicationSourceRevision=$ApplicationSourceRevision; verifierRevision=$env:GITHUB_SHA; verifiedAt=$verifiedAt;
    certificate=$expected.Identity; beforeTrust=$beforeTrust; afterCurrentUserTrust=$afterTrust;
    beforeTrustRejected=$true; afterCurrentUserTrustValid=$true; launcherSigned=$true; installerSigned=$true; uninstallerSigned=$true; certificateIdentityMatched=$true;
    installerSha256=$evidence.installerSha256; currentUserTrustOnly=$true; globalTrustModified=$false; privateIdentityInArtifacts=$false;
    scope='self-signed-authenticode-current-user-trust'; smartScreenBypassClaimed=$false
  }
} finally {
  $cleanupFailures = [System.Collections.Generic.List[string]]::new()
  foreach ($store in $addedStores) {
    try {
      # Attempt deletion even when the logical chain view does not expose the physical entry.
      $trustOperations.Add((Invoke-IsolatedUserTrust -Store (Split-Path -Leaf $store) -Operation 'delstore'))
    } catch { $cleanupFailures.Add((Split-Path -Leaf $store)) }
  }
  if ($cleanupFailures.Count -gt 0) { throw ('Isolated CurrentUser trust cleanup failed: ' + ($cleanupFailures -join ', ')) }
}
$afterTrustRemoval = Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus 'UntrustedRoot'
$signingEvidence['afterTrustRemoval'] = $afterTrustRemoval
$signingEvidence['trustRemovedNativeRejected'] = $true
$signingEvidence['currentUserTrustRemovedAfterVerification'] = $true
$signingEvidence['trustStoresAbsentBeforeVerification'] = $true
$signingEvidence['trustProviderDocumentation'] = 'https://learn.microsoft.com/en-us/windows/win32/api/cryptuiapi/nf-cryptuiapi-cryptuiwizimport'
$signingEvidence['physicalStoreDocumentation'] = 'https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore'
$signingEvidence['unprotectedFlagUsed'] = $false
$signingEvidence['trustStoreOperations'] = @($trustOperations)
if ($OriginalBuildRun) {
  foreach ($record in @($evidence,$signingEvidence)) {
    $record['originalBuildRun']=$OriginalBuildRun; $record['originalArtifactId']=$OriginalArtifactId; $record['originalArtifactSha256']=$OriginalArtifactSha256; $record['originalInstallerSha256']=$installerDigest
  }
}
Write-VerificationProgress 'Native verification and trust cleanup completed.'
$evidence | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'windows-native-evidence.json')
$signingEvidence | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'windows-signing-evidence.json')
$evidence | ConvertTo-Json -Compress
$signingEvidence | ConvertTo-Json -Depth 12 -Compress
