param(
  [Parameter(Mandatory=$true)][string]$SeedInstaller,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This verification requires a native Windows host.' }
$temporary = Join-Path $env:RUNNER_TEMP ('brcliopay-native-' + [guid]::NewGuid().ToString('N'))
$installation = Join-Path $temporary 'application'
$profile = Join-Path $temporary 'verification-profile'
New-Item -ItemType Directory -Force -Path $OutputDirectory,$temporary | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
if ($installation -match '\s') { throw 'The isolated NSIS verification directory must not contain spaces.' }
$executable = Join-Path $installation 'Brclio Pay.exe'

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

Install-Package $SeedInstaller
$before = Read-Smoke '0.9.9' 'windows-before-upgrade'
$marker = Join-Path $profile 'retained-client-setting.json'
$markerText = '{"verification":"settings-survive-upgrade"}'
Set-Content -NoNewline -Encoding utf8 -LiteralPath $marker -Value $markerText
Install-Package $Installer
$after = Read-Smoke '1.0.0' 'windows-after-upgrade'
if (-not $after.verificationProfileReused -or $after.previousSmokeVersion -ne '0.9.9' -or (Get-Content -Raw -LiteralPath $marker) -ne $markerText) { throw 'Upgrade did not preserve the isolated client profile.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
$evidence = [ordered]@{
  schema=1; platform='win32-x64'; version='1.0.0'; sourceRevision=$env:GITHUB_SHA;
  verifiedAt=(Get-Date).ToUniversalTime().ToString('o'); nativeWindows=$true;
  installationVerified=$true; upgradeVerified=$true; profilePreserved=$true;
  liveLoginVerified=$true; remoteIsolationVerified=$true;
  installerSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant();
  commercialSignatureStatus=[string]$signature.Status
}
$evidence | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'windows-native-evidence.json')
$evidence | ConvertTo-Json -Compress
