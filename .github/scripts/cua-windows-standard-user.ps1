# Hosted Windows jobs run elevated. Exercise the desktop as a standard user:
# Cua intentionally refuses browser installations writable by its own token.
param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$Script
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class CuaCiStandardUser {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Startup {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedBytes;
        public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct Label { public IntPtr sid; public uint attributes; }

    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool SaferCreateLevel(uint scope, uint level, uint flags, out IntPtr handle, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr input, out IntPtr token, uint flags, IntPtr reserved);
    [DllImport("advapi32.dll")] static extern bool SaferCloseLevel(IntPtr level);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertStringSidToSid(string value, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool SetTokenInformation(IntPtr token, int kind, ref Label label, uint length);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command,
        IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment,
        string directory, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    public static int Run(string executable, string script, string directory) {
        IntPtr level=IntPtr.Zero, token=IntPtr.Zero, sid=IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        try {
            // No inert-policy flag: retain AppLocker and normal access checks.
            Check(SaferCreateLevel(1, 0x20000, 1, out level, IntPtr.Zero), "SaferCreateLevel");
            Check(SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero), "SaferComputeTokenFromLevel");
            Check(ConvertStringSidToSid("S-1-16-8192", out sid), "medium integrity SID");
            var label = new Label { sid=sid, attributes=0x20 };
            Check(SetTokenInformation(token, 25, ref label, (uint)Marshal.SizeOf<Label>() + GetLengthSid(sid)), "medium integrity token");
            using (var identity = new WindowsIdentity(token)) {
                if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Smoke token still enables Administrators");
            }
            var startup = new Startup {
                cb=(uint)Marshal.SizeOf<Startup>(), flags=0x100,
                input=GetStdHandle(-10), output=GetStdHandle(-11), error=GetStdHandle(-12)
            };
            foreach (var handle in new[] { startup.input, startup.output, startup.error })
                Check(SetHandleInformation(handle, 1, 1), "inherit CI standard streams");
            var command = new StringBuilder("\"" + executable + "\" \"" + script + "\"");
            Check(CreateProcessAsUser(token, executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0, IntPtr.Zero, directory, ref startup, out process), "CreateProcessAsUser");
            if (WaitForSingleObject(process.process, 180000) != 0) {
                TerminateProcess(process.process, 124);
                throw new TimeoutException("Standard-user Windows smoke did not exit in 180 seconds");
            }
            uint code;
            Check(GetExitCodeProcess(process.process, out code), "smoke exit code");
            return (int)code;
        } finally {
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
            if (sid != IntPtr.Zero) LocalFree(sid);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (level != IntPtr.Zero) SaferCloseLevel(level);
        }
    }
}
'@
exit [CuaCiStandardUser]::Run((Resolve-Path $Executable).Path, (Resolve-Path $Script).Path, $PWD.Path)
