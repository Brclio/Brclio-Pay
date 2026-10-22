param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true'){throw 'Probe requires an isolated native Windows CI runner.'}
. (Join-Path $PSScriptRoot '../scripts/windows-certificate-policy.ps1')
$expected=Get-ExpectedWindowsSigningIdentity
$PSScriptRootForStore=(Resolve-Path (Join-Path $PSScriptRoot '../scripts')).Path
function Write-VerificationProgress([string]$Message){Write-Host ((Get-Date).ToUniversalTime().ToString('o')+' '+$Message)}
function Invoke-IsolatedUserTrust {
  param([ValidateSet('Root','TrustedPublisher')][string]$Store,[ValidateSet('addstore','delstore')][string]$Operation)
  Write-VerificationProgress ('Begin bounded CurrentUser certificate operation: ' + $Operation + ' ' + $Store)
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = (Get-Process -Id $PID).Path
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRootForStore 'windows-user-certificate-store.ps1'),'-Store',$Store,'-Operation',$Operation)) { $info.ArgumentList.Add($argument) }
  $process = [System.Diagnostics.Process]::Start($info)
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill($true); $process.WaitForExit(); Write-Host ($stderr.GetAwaiter().GetResult()); throw 'CurrentUser certificate operation exceeded its 30 second process deadline.' }
    $output = $stdout.GetAwaiter().GetResult(); $diagnostic = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { Write-Host $diagnostic; throw ('CurrentUser certificate operation failed with exit code ' + $process.ExitCode + '.') }
    $operationEvidence = $output | ConvertFrom-Json
    if ($operationEvidence.schema -ne 1 -or $operationEvidence.scope -ne 'CurrentUser' -or $operationEvidence.provider -ne 'CERT_STORE_PROV_REG' -or $operationEvidence.registryScope -ne 'HKCU' -or $operationEvidence.physicalStorePresenceVerified -ne $true -or $operationEvidence.store -ne $Store -or $operationEvidence.operation -ne $Operation -or $operationEvidence.certificateSha256 -cne $expected.Identity.certificateSha256 -or $operationEvidence.unprotectedFlagUsed -ne $false -or $operationEvidence.globalTrustModified -ne $false) { throw 'Physical CurrentUser store operation provenance mismatch.' }
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
  return [pscustomobject]@{ scope='CurrentUser'; provider='CERT_STORE_PROV_REG'; store=$Store; operation=$Operation; verified=$true; physicalStorePresenceVerified=$true; logicalStoreVisible=$present; deadlineSeconds=30; certificateSha256=$expected.Identity.certificateSha256 }
}

$stores=@('Root','TrustedPublisher');$owned=[System.Collections.Generic.List[string]]::new();$operations=[System.Collections.Generic.List[object]]::new()
foreach($store in $stores){if(Test-Path ('Cert:\CurrentUser\'+$store+'\'+$expected.Identity.certificateThumbprintSha1)){throw 'Probe must start without the fixed certificate trusted.'}}
if((Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant() -cne 'd8227773e0689af5b1416dbb92c11091065bdc8fc670ada4e3aa65de72cd7986'){throw 'Original signed installer checksum mismatch.'}
try {
 $before=Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus UntrustedRoot
 foreach($store in $stores){$owned.Add($store);$operations.Add((Invoke-IsolatedUserTrust -Store $store -Operation addstore))}
 $after=Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus Valid
} finally {
 $errors=[System.Collections.Generic.List[string]]::new()
 foreach($store in $owned){try{$operations.Add((Invoke-IsolatedUserTrust -Store $store -Operation delstore))}catch{$errors.Add($store)}}
 if($errors.Count){throw ('Probe cleanup failed: '+($errors -join ', '))}
}
$removed=Read-WindowsAuthenticodeEvidence -Path $Installer -Expected $expected -RequiredStatus UntrustedRoot
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
[ordered]@{schema=1;applicationSourceRevision='1d5c981361ace4fe49931ad40934043e180d3ad7';verifierRevision=$env:GITHUB_SHA;installerSha256='d8227773e0689af5b1416dbb92c11091065bdc8fc670ada4e3aa65de72cd7986';before=$before;after=$after;afterRemoval=$removed;currentUserTrustRemoved=$true;operations=@($operations);providerDocumentation='https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore';unprotectedFlagUsed=$false;globalTrustModified=$false} | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'windows-trust-probe.json')
