param([Parameter(Mandatory=$true)][ValidateSet('Root','TrustedPublisher')][string]$Store,[Parameter(Mandatory=$true)][ValidateSet('addstore','delstore')][string]$Operation)
$ErrorActionPreference='Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Public certificate store verification is restricted to an isolated native Windows CI runner.' }
. (Join-Path $PSScriptRoot 'windows-certificate-policy.ps1')
$expected=Get-ExpectedWindowsSigningIdentity
# Open the documented physical SystemRegistry provider, scoped only to CurrentUser (0x00010000).
# No logical store UI, LocalMachine store, or CERT_SYSTEM_STORE_UNPROTECTED_FLAG is used.
# https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore
# https://learn.microsoft.com/en-us/windows/win32/seccrypto/system-store-locations
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class BrclioPhysicalUserCertificateStore {
  [StructLayout(LayoutKind.Sequential)] private struct CertificateContext { public uint encoding; public IntPtr bytes; public uint length; public IntPtr info; public IntPtr store; }
  [DllImport("crypt32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] private static extern IntPtr CertOpenStore(IntPtr provider,uint encoding,IntPtr cryptProvider,uint flags,string store);
  [DllImport("crypt32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CertAddEncodedCertificateToStore(IntPtr store,uint encoding,byte[] certificate,uint length,uint disposition,out IntPtr context);
  [DllImport("crypt32.dll",SetLastError=true)] private static extern IntPtr CertEnumCertificatesInStore(IntPtr store,IntPtr previous);
  [DllImport("crypt32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CertDeleteCertificateFromStore(IntPtr context);
  [DllImport("crypt32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CertFreeCertificateContext(IntPtr context);
  [DllImport("crypt32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CertCloseStore(IntPtr store,uint flags);
  private static bool EqualCertificate(IntPtr pointer,byte[] expected) {
    var context=Marshal.PtrToStructure<CertificateContext>(pointer);
    if(context.length!=expected.Length) return false;
    var actual=new byte[context.length]; Marshal.Copy(context.bytes,actual,0,actual.Length);
    return CryptographicOperations.FixedTimeEquals(actual,expected);
  }
  public static bool Contains(string storeName,byte[] certificate) {
    if(storeName!="Root"&&storeName!="TrustedPublisher") throw new ArgumentException("Unsupported isolated user store.");
    IntPtr store=CertOpenStore(new IntPtr(13),0,IntPtr.Zero,0x00018000,storeName);
    if(store==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Reopening physical CurrentUser store failed.");
    IntPtr previous=IntPtr.Zero;
    try {
      for(;;) {
        previous=CertEnumCertificatesInStore(store,previous);
        if(previous==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(unchecked((uint)error)!=0x80092004) throw new Win32Exception(error,"Enumerating physical CurrentUser store failed."); return false; }
        if(EqualCertificate(previous,certificate)) return true;
      }
    } finally { if(previous!=IntPtr.Zero) CertFreeCertificateContext(previous); if(!CertCloseStore(store,0)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Closing physical CurrentUser store failed."); }
  }
  public static bool Change(string storeName,bool add,byte[] certificate) {
    if(storeName!="Root"&&storeName!="TrustedPublisher") throw new ArgumentException("Unsupported isolated user store.");
    // CERT_STORE_PROV_SYSTEM_REGISTRY_W=13; CERT_SYSTEM_STORE_CURRENT_USER=0x00010000.
    IntPtr store=CertOpenStore(new IntPtr(13),0,IntPtr.Zero,0x00010000,storeName);
    if(store==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Opening physical CurrentUser store failed.");
    try {
      if(add) {
        IntPtr context;
        // CERT_STORE_ADD_NEW=1: never replace another existing entry.
        if(!CertAddEncodedCertificateToStore(store,0x00010001,certificate,(uint)certificate.Length,1,out context)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Adding fixed public certificate failed.");
        try { if(!EqualCertificate(context,certificate)) throw new InvalidOperationException("Physical store returned another certificate."); }
        finally { if(context!=IntPtr.Zero) CertFreeCertificateContext(context); }
        return true;
      }
      IntPtr previous=IntPtr.Zero;
      try {
        for(;;) {
          previous=CertEnumCertificatesInStore(store,previous);
          if(previous==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(unchecked((uint)error)!=0x80092004) throw new Win32Exception(error,"Enumerating physical CurrentUser store failed."); return false; }
          if(EqualCertificate(previous,certificate)) {
            IntPtr found=previous; previous=IntPtr.Zero;
            if(!CertDeleteCertificateFromStore(found)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Deleting fixed public certificate failed.");
            return true;
          }
        }
      } finally { if(previous!=IntPtr.Zero) CertFreeCertificateContext(previous); }
    } finally { if(!CertCloseStore(store,0)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Closing physical CurrentUser store failed."); }
  }
}
'@
$changed=[BrclioPhysicalUserCertificateStore]::Change($Store,($Operation -eq 'addstore'),$expected.Certificate.RawData)
$physicalPresent=[BrclioPhysicalUserCertificateStore]::Contains($Store,$expected.Certificate.RawData)
if ($physicalPresent -ne ($Operation -eq 'addstore')) { throw 'Physical CurrentUser store persistence did not match the requested fixed certificate operation.' }
[ordered]@{schema=1;scope='CurrentUser';provider='CERT_STORE_PROV_SYSTEM_REGISTRY_W';store=$Store;operation=$Operation;changed=$changed;physicalStorePresenceVerified=$true;certificateSha256=$expected.Identity.certificateSha256;unprotectedFlagUsed=$false;globalTrustModified=$false} | ConvertTo-Json -Compress
