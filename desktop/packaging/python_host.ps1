# System Windows PowerShell hosts the bundled CPython DLL in this process.
# All Python libraries come from runtime; an installed Python is not used.
$ErrorActionPreference = 'Stop'

try {
    $applicationRoot = if ($env:PLAN_MATTER_ROOT) {
        (Resolve-Path -LiteralPath $env:PLAN_MATTER_ROOT).Path
    } else {
        Split-Path -Parent $PSScriptRoot
    }
    $runtimeDirectory = Join-Path $applicationRoot 'runtime'
    $applicationScript = Join-Path $applicationRoot 'app\studio_launcher.py'
    if (!(Test-Path -LiteralPath $applicationScript -PathType Leaf)) {
        throw 'The application directory is incomplete.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class PlanMatterPythonHost {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr LoadLibraryW(string path);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetDllDirectoryW(string path);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int PythonMain(int count, IntPtr args);

    static string[] Arguments(string raw) {
        int count;
        // Parse Windows quoting rules once. Raw arguments are never evaluated
        // as PowerShell commands or interpolated into another shell.
        IntPtr vector = CommandLineToArgvW("PlanMatter " + (raw ?? ""), out count);
        if (vector == IntPtr.Zero) throw new Exception("Cannot parse launch arguments.");
        try {
            var result = new List<string>();
            for (int index = 1; index < count; index++)
                result.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(vector, index * IntPtr.Size)));
            return result.ToArray();
        } finally {
            LocalFree(vector);
        }
    }

    public static int Run(string runtime, string script, string raw) {
        if (!Environment.Is64BitProcess)
            throw new Exception("The application requires 64-bit Windows PowerShell.");
        if (!SetDllDirectoryW(runtime))
            throw new Exception("Cannot configure the bundled runtime: " + Marshal.GetLastWin32Error());
        IntPtr library = LoadLibraryW(Path.Combine(runtime, "python311.dll"));
        if (library == IntPtr.Zero)
            throw new Exception("Cannot load the bundled runtime: " + Marshal.GetLastWin32Error());
        IntPtr entry = GetProcAddress(library, "Py_Main");
        if (entry == IntPtr.Zero) throw new Exception("The bundled runtime has no Py_Main entry point.");
        PythonMain main = (PythonMain)Marshal.GetDelegateForFunctionPointer(entry, typeof(PythonMain));
        var args = new List<string> { Path.Combine(runtime, "pythonw.exe"), "-I", "-X", "utf8", "-u", script };
        args.AddRange(Arguments(raw));
        IntPtr vector = Marshal.AllocHGlobal(args.Count * IntPtr.Size);
        IntPtr[] strings = new IntPtr[args.Count];
        try {
            for (int index = 0; index < args.Count; index++) {
                strings[index] = Marshal.StringToHGlobalUni(args[index]);
                Marshal.WriteIntPtr(vector, index * IntPtr.Size, strings[index]);
            }
            return main(args.Count, vector);
        } finally {
            foreach (IntPtr item in strings) if (item != IntPtr.Zero) Marshal.FreeHGlobal(item);
            Marshal.FreeHGlobal(vector);
        }
    }
}
'@
    exit [PlanMatterPythonHost]::Run($runtimeDirectory, $applicationScript, $env:PLAN_MATTER_LAUNCH_ARGS)
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
