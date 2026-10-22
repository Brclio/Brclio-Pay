# Shared Windows signing policy. Contains public identity only; never loads credentials.
$ErrorActionPreference = 'Stop'
function Get-ExpectedWindowsSigningIdentity {
  $shared = Join-Path $PSScriptRoot '../shared'
  $identity = Get-Content -Raw -LiteralPath (Join-Path $shared 'windows-signing-identity.json') | ConvertFrom-Json -DateKind String
  $certificatePath = (Resolve-Path -LiteralPath (Join-Path $shared 'windows-signing-certificate.cer')).Path
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
  $digest = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($certificate.RawData)).ToLowerInvariant()
  if ($identity.schema -ne 1 -or $identity.publisher -ne 'Brclio Pay' -or $identity.selfSigned -ne $true -or $identity.usage -ne 'codeSigning' -or $identity.keyAlgorithm -ne 'RSA' -or $identity.keyBits -ne 3072) { throw 'Unexpected Windows signing identity metadata.' }
  if ($identity.certificateSha256 -cne $digest -or $identity.certificateThumbprintSha1 -cne $certificate.Thumbprint -or $certificate.HasPrivateKey) { throw 'Public Windows certificate integrity mismatch.' }
  if ($certificate.Subject -ne $certificate.Issuer -or $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne $identity.publisher) { throw 'Windows publisher identity mismatch.' }
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
  try { if ($null -eq $rsa -or $rsa.KeySize -ne 3072) { throw 'Unsupported Windows publisher key.' } } finally { if ($null -ne $rsa) { $rsa.Dispose() } }
  $usage = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
  $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usage,$usage.Critical)
  if ($eku.EnhancedKeyUsages.Count -ne 1 -or $eku.EnhancedKeyUsages[0].Value -ne '1.3.6.1.5.5.7.3.3') { throw 'Certificate is not restricted to code signing.' }
  $constraints = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' }
  $basic = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($constraints,$constraints.Critical)
  if ($basic.CertificateAuthority -or [DateTime]::UtcNow -lt $certificate.NotBefore.ToUniversalTime() -or [DateTime]::UtcNow -gt $certificate.NotAfter.ToUniversalTime()) { throw 'Invalid Windows code-signing certificate validity or CA constraints.' }
  return [pscustomobject]@{ Identity=$identity; Certificate=$certificate; CertificatePath=$certificatePath }
}
function Read-WindowsAuthenticodeEvidence {
  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)]$Expected,[Parameter(Mandatory=$true)][ValidateSet('UntrustedRoot','Valid')][string]$RequiredStatus)
  Write-Host ((Get-Date).ToUniversalTime().ToString('o') + ' Begin native Authenticode: ' + [IO.Path]::GetFileName($Path) + '; required ' + $RequiredStatus)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  # PowerShell maps CERT_E_UNTRUSTEDROOT to UnknownError; NotTrusted means explicit distrust.
  # Keep this strict: a missing/changed native DWORD field is an audit failure, not a fallback.
  $nativeField = [System.Management.Automation.Signature].GetField('_win32Error',([System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic))
  if ($null -eq $nativeField -or $nativeField.FieldType -ne [uint32]) { throw 'The native Authenticode trust result is unavailable.' }
  $rawStatus = [string]$signature.Status
  $rawCode = '0x{0:X8}' -f $nativeField.GetValue($signature)
  Write-Host ((Get-Date).ToUniversalTime().ToString('o') + ' Native Authenticode result: ' + [IO.Path]::GetFileName($Path) + '; ' + $rawStatus + ' / ' + $rawCode)
  $expectedTrustState = if ($RequiredStatus -eq 'UntrustedRoot') { $rawStatus -ceq 'UnknownError' -and $rawCode -ceq '0x800B0109' } else { $rawStatus -ceq 'Valid' -and $rawCode -ceq '0x00000000' }
  if (-not $expectedTrustState -or $null -eq $signature.SignerCertificate) { throw "Unexpected Authenticode result for $([IO.Path]::GetFileName($Path)): $rawStatus / $rawCode / $($signature.StatusMessage)." }
  $certificate = $signature.SignerCertificate
  $digest = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($certificate.RawData)).ToLowerInvariant()
  if ($digest -cne $Expected.Identity.certificateSha256 -or $certificate.Thumbprint -cne $Expected.Identity.certificateThumbprintSha1 -or $certificate.Subject -cne $Expected.Certificate.Subject -or $certificate.Issuer -cne $Expected.Certificate.Issuer) { throw 'Authenticode publisher certificate does not match the pinned identity.' }
  return [pscustomobject][ordered]@{ name=[IO.Path]::GetFileName($Path); status=$RequiredStatus; rawStatus=$rawStatus; rawWin32ErrorHex=$rawCode; statusMessage=$signature.StatusMessage; subject=$certificate.Subject; issuer=$certificate.Issuer; publisher=$certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false); certificateSha256=$digest; thumbprintSha1=$certificate.Thumbprint; fileSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
}
