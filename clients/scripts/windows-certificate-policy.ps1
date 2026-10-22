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
  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)]$Expected,[Parameter(Mandatory=$true)][ValidateSet('NotTrusted','Valid')][string]$RequiredStatus)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ([string]$signature.Status -ne $RequiredStatus -or $null -eq $signature.SignerCertificate) { throw "Unexpected Authenticode status for $([IO.Path]::GetFileName($Path)): $($signature.Status)." }
  $certificate = $signature.SignerCertificate
  $digest = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($certificate.RawData)).ToLowerInvariant()
  if ($digest -cne $Expected.Identity.certificateSha256 -or $certificate.Thumbprint -cne $Expected.Identity.certificateThumbprintSha1 -or $certificate.Subject -cne $Expected.Certificate.Subject -or $certificate.Issuer -cne $Expected.Certificate.Issuer) { throw 'Authenticode publisher certificate does not match the pinned identity.' }
  return [pscustomobject][ordered]@{ name=[IO.Path]::GetFileName($Path); status=[string]$signature.Status; subject=$certificate.Subject; issuer=$certificate.Issuer; publisher=$certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false); certificateSha256=$digest; thumbprintSha1=$certificate.Thumbprint; fileSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
}
