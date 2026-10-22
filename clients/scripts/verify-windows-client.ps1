param(
  [Parameter(Mandatory=$true)][string]$SeedInstaller,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$SeedVersion='1.0.0'
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'This verification requires an isolated native Windows GitHub Actions runner.' }
. (Join-Path $PSScriptRoot 'windows-certificate-policy.ps1')
$expected = Get-ExpectedWindowsSigningIdentity
$settings = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../shared/release-settings.json') | ConvertFrom-Json
$currentVersion = [string]$settings.version
if ($SeedVersion -ne '1.0.0' -or $currentVersion -notmatch '^\d+\.\d+\.\d+$' -or $currentVersion -eq $SeedVersion) { throw 'Unexpected Windows upgrade verification versions.' }
if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'Native verification must be bound to the checked-out source revision.' }
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

function Install-Package([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'A reviewed installer is missing.' }
  $process = Start-Process -FilePath (Resolve-Path -LiteralPath $Path).Path -ArgumentList @('/S',"/D=$installation") -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "NSIS returned exit code $($process.ExitCode)." }
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'NSIS did not install the expected executable.' }
}
function Read-Smoke([string]$Version,[string]$Label) {
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
  return $report
}

try {
  $beforeInstaller = Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus 'NotTrusted'
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
  $beforeTrust = @($beforeInstaller,(Read-WindowsAuthenticodeEvidence -Path $executable -Expected $expected -RequiredStatus 'NotTrusted'),(Read-WindowsAuthenticodeEvidence -Path $uninstaller -Expected $expected -RequiredStatus 'NotTrusted'))
  foreach ($store in $stores) {
    Import-Certificate -FilePath $expected.CertificatePath -CertStoreLocation $store | Out-Null
    $addedStores.Add($store)
  }
  $afterTrust = @((Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus 'Valid'),(Read-WindowsAuthenticodeEvidence -Path $executable -Expected $expected -RequiredStatus 'Valid'),(Read-WindowsAuthenticodeEvidence -Path $uninstaller -Expected $expected -RequiredStatus 'Valid'))
  $verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
  $evidence = [ordered]@{
    schema=1; platform='win32-x64'; version=$currentVersion; sourceRevision=$env:GITHUB_SHA;
    verifiedAt=$verifiedAt; nativeWindows=$true;
    installationVerified=$true; upgradeVerified=$true; profilePreserved=$true;
    liveLoginVerified=$true; remoteIsolationVerified=$true;
    installerSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant();
    commercialSignatureStatus='SelfSigned'; authenticodeStatusAfterCurrentUserTrust='Valid';
    certificateSha256=$expected.Identity.certificateSha256; publisher=$expected.Identity.publisher
  }
  $signingEvidence = [ordered]@{
    schema=1; platform='win32-x64'; version=$currentVersion; sourceRevision=$env:GITHUB_SHA; verifiedAt=$verifiedAt;
    certificate=$expected.Identity; beforeTrust=$beforeTrust; afterCurrentUserTrust=$afterTrust;
    beforeTrustRejected=$true; afterCurrentUserTrustValid=$true; launcherSigned=$true; installerSigned=$true; uninstallerSigned=$true; certificateIdentityMatched=$true;
    installerSha256=$evidence.installerSha256; currentUserTrustOnly=$true; globalTrustModified=$false; privateIdentityInArtifacts=$false;
    scope='self-signed-authenticode-current-user-trust'; smartScreenBypassClaimed=$false
  }
} finally {
  foreach ($store in $addedStores) {
    Remove-Item -LiteralPath (Join-Path $store $expected.Identity.certificateThumbprintSha1) -ErrorAction Stop
  }
}
$signingEvidence['currentUserTrustRemovedAfterVerification'] = $true
$evidence | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'windows-native-evidence.json')
$signingEvidence | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'windows-signing-evidence.json')
$evidence | ConvertTo-Json -Compress
$signingEvidence | ConvertTo-Json -Depth 12 -Compress
