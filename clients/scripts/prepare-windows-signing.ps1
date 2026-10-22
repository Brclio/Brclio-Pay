# CI-only credential provisioning. The private identity must never enter a build artifact.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or [string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) { throw 'Windows signing provisioning requires an isolated GitHub Actions runner.' }
if ([string]::IsNullOrWhiteSpace($env:BRCLIO_WINDOWS_SIGNING_PFX_BASE64) -or [string]::IsNullOrWhiteSpace($env:BRCLIO_WINDOWS_SIGNING_PASSWORD)) { throw 'The two dedicated Windows signing secrets are required.' }
. (Join-Path $PSScriptRoot 'windows-certificate-policy.ps1')
$expected = Get-ExpectedWindowsSigningIdentity
$bytes = [Convert]::FromBase64String($env:BRCLIO_WINDOWS_SIGNING_PFX_BASE64)
if ($bytes.Length -lt 1000 -or $bytes.Length -gt 12000) { throw 'Invalid Windows signing identity size.' }
$private = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes,$env:BRCLIO_WINDOWS_SIGNING_PASSWORD,[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
try {
  $digest = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($private.RawData)).ToLowerInvariant()
  if (-not $private.HasPrivateKey -or $digest -cne $expected.Identity.certificateSha256 -or $private.Thumbprint -cne $expected.Identity.certificateThumbprintSha1) { throw 'Private signing identity does not match the public trust root.' }
  $directory = Join-Path $env:RUNNER_TEMP 'brcliopay-windows-private-signing'
  if (Test-Path -LiteralPath $directory) { throw 'Private signing directory already exists.' }
  New-Item -ItemType Directory -Path $directory | Out-Null
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $directory '/inheritance:r' '/grant:r' "$($user):(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict temporary signing identity permissions.' }
  $file = Join-Path $directory 'identity.pfx'
  [IO.File]::WriteAllBytes($file,$bytes)
  [IO.File]::AppendAllText($env:GITHUB_ENV,"WIN_CSC_LINK=$file`nWIN_CSC_KEY_PASSWORD=$($env:BRCLIO_WINDOWS_SIGNING_PASSWORD)`n")
  [ordered]@{ prepared=$true; pinnedPublisher=$expected.Identity.publisher; certificateSha256=$digest; privateIdentityInArtifacts=$false } | ConvertTo-Json -Compress
} finally { $private.Dispose(); [Array]::Clear($bytes,0,$bytes.Length) }
