# CI-only fixture for the real user-consent path; never packaged in the application.
$ErrorActionPreference='Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Certificate consent fixture is restricted to an isolated native Windows CI runner.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public sealed class BrclioConsentResult {
 public bool Approved; public bool Ambiguous; public string Reason; public string Title; public string DialogText; public string DialogTextSha256; public bool PublisherMatched; public bool FingerprintMatched; public bool OwnedProcessMatched; public int ApprovedControlId;
}
public static class BrclioOwnedCertificateConsent {
 private delegate bool EnumProc(IntPtr window,IntPtr parameter);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
 [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr parameter);
 [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr control);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] private static extern IntPtr SendText(IntPtr window,uint message,IntPtr wParam,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",ExactSpelling=true,SetLastError=true)] private static extern IntPtr SendControl(IntPtr window,uint message,IntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
 private static string Class(IntPtr window){var text=new StringBuilder(256);GetClassName(window,text,text.Capacity);return text.ToString();}
 private static string Text(IntPtr window){var text=new StringBuilder(16384);if(GetWindowText(window,text,text.Capacity)==0){UIntPtr ignored;SendText(window,0x000D,new IntPtr(text.Capacity),text,3,250,out ignored);}return text.ToString();}
 public static BrclioConsentResult TryApprove(int importerPid,string publisher,string sha1){
  if(importerPid<=0||publisher!="Brclio Pay"||sha1!="54E4378450A3DB86C0D11E338FA30B0FD8C19A4B")throw new ArgumentException("Consent fixture requires the fixed public identity and owned importer PID.");
  var windows=new List<IntPtr>();
  EnumWindows((window,parameter)=>{uint owner;GetWindowThreadProcessId(window,out owner);if(owner==(uint)importerPid&&IsWindowVisible(window)&&Class(window)=="#32770")windows.Add(window);return true;},IntPtr.Zero);
  if(windows.Count==0)return new BrclioConsentResult{Reason="no-owned-dialog"};
  if(windows.Count!=1)return new BrclioConsentResult{Ambiguous=true,Reason="ambiguous-owned-native-dialogs"};
  var dialog=windows[0];var parts=new List<string>{Text(dialog)};
  EnumChildWindows(dialog,(child,parameter)=>{if(parts.Count>256)return false;var text=Text(child);if(!String.IsNullOrWhiteSpace(text))parts.Add(text);return true;},IntPtr.Zero);
  var all=String.Join("\n",parts);var title=Text(dialog);var hexadecimal=new StringBuilder();foreach(char c in all){if(Uri.IsHexDigit(c))hexadecimal.Append(Char.ToUpperInvariant(c));}
  bool publisherMatched=all.IndexOf(publisher,StringComparison.Ordinal)>=0;bool fingerprintMatched=hexadecimal.ToString().Contains(sha1,StringComparison.Ordinal);
  var result=new BrclioConsentResult{Title=title,DialogText=all,DialogTextSha256=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(all))).ToLowerInvariant(),PublisherMatched=publisherMatched,FingerprintMatched=fingerprintMatched,OwnedProcessMatched=true,Reason="owned-dialog-identity-not-yet-matched"};
  if(title!="Security Warning"||!publisherMatched||!fingerprintMatched)return result;
  var yes=GetDlgItem(dialog,6);uint ownerPid;GetWindowThreadProcessId(yes,out ownerPid);
  if(yes==IntPtr.Zero||ownerPid!=(uint)importerPid||GetDlgCtrlID(yes)!=6||Class(yes)!="Button"||Text(yes).Replace("&",String.Empty)!="Yes"||!IsWindowVisible(yes)||!IsWindowEnabled(yes)){result.Reason="owned-yes-control-not-matched";return result;}
  UIntPtr ignoredResult;
  if(SendControl(yes,0x00F5,IntPtr.Zero,IntPtr.Zero,3,1000,out ignoredResult)==IntPtr.Zero){result.Reason="owned-yes-control-did-not-respond";return result;}
  result.Approved=true;result.ApprovedControlId=6;result.Reason="exact-owned-public-certificate-consent-fixture-approved";return result;
 }
}
'@
