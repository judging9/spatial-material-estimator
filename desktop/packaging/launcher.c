/* SPDX-License-Identifier: GPL-3.0-or-later
 * Windows GUI entry point for the portable material estimating application.
 * Build: gcc -municode -mwindows -O2 -static-libgcc launcher.c -o app.exe
 */
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>

#define PATH_CAPACITY 32768

static void report_error(const wchar_t *message, const wchar_t *detail) {
    wchar_t buffer[2048];
    _snwprintf(buffer, 2047, L"%ls\n\n%ls", message, detail ? detail : L"");
    buffer[2047] = L'\0';
    /* Keep USER32 out of the launcher's static import table. Managed Windows
     * may block GUI DLL initialization for newly built executables; the actual
     * UI belongs to the Python process and may use the compatibility fallback.
     */
    HMODULE user32 = LoadLibraryW(L"user32.dll");
    if (user32) {
        typedef int (WINAPI *MessageBoxFunction)(HWND, LPCWSTR, LPCWSTR, UINT);
        MessageBoxFunction show = (MessageBoxFunction)GetProcAddress(user32, "MessageBoxW");
        if (show) show(NULL, buffer, L"材料报价 - 启动失败", MB_OK | MB_ICONERROR);
        FreeLibrary(user32);
    }
    OutputDebugStringW(buffer);
}

static DWORD probe_runtime(const wchar_t *python, const wchar_t *directory,
                           HANDLE input, HANDLE log) {
    wchar_t command[PATH_CAPACITY + 256];
    _snwprintf(command, PATH_CAPACITY + 255,
        L"\"%ls\" -X utf8 -u -c \"import tkinter,ctypes,ssl,requests,openpyxl; print('Runtime dependency probe OK')\"",
        python);
    command[PATH_CAPACITY + 255] = L'\0';
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = input;
    startup.hStdOutput = log;
    startup.hStdError = log;
    PROCESS_INFORMATION process = {0};
    if (!CreateProcessW(python, command, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, directory, &startup, &process))
        return GetLastError() ? GetLastError() : 1;
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    return code;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous,
                   PWSTR arguments, int show_command) {
    (void)instance; (void)previous; (void)show_command;
    wchar_t *directory = calloc(PATH_CAPACITY, sizeof(wchar_t));
    wchar_t *python = calloc(PATH_CAPACITY, sizeof(wchar_t));
    wchar_t *script = calloc(PATH_CAPACITY, sizeof(wchar_t));
    wchar_t *log_directory = calloc(PATH_CAPACITY, sizeof(wchar_t));
    wchar_t *log_file = calloc(PATH_CAPACITY, sizeof(wchar_t));
    if (!directory || !python || !script || !log_directory || !log_file) {
        report_error(L"内存不足，无法启动。", L"");
        return 1;
    }
    DWORD length = GetModuleFileNameW(NULL, directory, PATH_CAPACITY);
    if (!length || length >= PATH_CAPACITY - 1) {
        report_error(L"无法确定程序所在目录。", L"");
        return 1;
    }
    wchar_t *slash = wcsrchr(directory, L'\\');
    if (!slash) return 1;
    *slash = L'\0';
    if (wcslen(directory) + 100 >= PATH_CAPACITY) return 1;
    _snwprintf(python, PATH_CAPACITY, L"%ls\\runtime\\pythonw.exe", directory);
    _snwprintf(script, PATH_CAPACITY, L"%ls\\app\\main.py", directory);
    _snwprintf(log_directory, PATH_CAPACITY, L"%ls\\logs", directory);
    _snwprintf(log_file, PATH_CAPACITY, L"%ls\\launcher.log", log_directory);
    if (GetFileAttributesW(python) == INVALID_FILE_ATTRIBUTES ||
        GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
        report_error(L"程序文件不完整，请重新解压完整发行目录。",
                     L"请保留 exe 同目录的 app 和 runtime 文件夹。");
        return 2;
    }
    CreateDirectoryW(log_directory, NULL);
    SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
    HANDLE log = CreateFileW(log_file, FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, NULL);
    if (log == INVALID_HANDLE_VALUE) {
        report_error(L"当前目录不可写，无法记录运行日志。",
                     L"请把完整程序目录复制到可写位置后启动。");
        return 3;
    }
    const char marker[] = "\r\n--- Application launch ---\r\n";
    DWORD written;
    WriteFile(log, marker, sizeof(marker) - 1, &written, NULL);
    HANDLE input = CreateFileW(L"NUL", GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, NULL);
    /* Some managed Windows environments reject DLL initialization for copied
     * interpreters. An installed interpreter is an explicit compatibility
     * fallback; standalone distributions still prefer their included runtime.
     */
    if (probe_runtime(python, directory, input, log)) {
        wchar_t fallback[PATH_CAPACITY];
        DWORD found = SearchPathW(NULL, L"pythonw.exe", NULL, PATH_CAPACITY,
                                  fallback, NULL);
        if (!found || found >= PATH_CAPACITY ||
            _wcsicmp(fallback, python) == 0 ||
            probe_runtime(fallback, directory, input, log)) {
            if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
            CloseHandle(log);
            if (!wcsstr(arguments, L"--self-test"))
                report_error(L"Windows 未能加载程序运行环境，请查看日志。", log_file);
            return 5;
        }
        const char notice[] = "Using installed Python compatibility fallback.\r\n";
        WriteFile(log, notice, sizeof(notice) - 1, &written, NULL);
        wcscpy(python, fallback);
    }
    size_t command_size = wcslen(python) + wcslen(script) +
                          wcslen(arguments) + 40;
    wchar_t *command = calloc(command_size, sizeof(wchar_t));
    if (!command) return 1;
    /* No shell is involved. All filesystem paths are individually quoted. */
    _snwprintf(command, command_size, L"\"%ls\" -X utf8 -u \"%ls\" %ls",
               python, script, arguments);
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = input;
    startup.hStdOutput = log;
    startup.hStdError = log;
    PROCESS_INFORMATION process = {0};
    /* The application keeps writable projects/data beside this launcher. */
    SetEnvironmentVariableW(L"MATERIAL_QUOTE_HOME", directory);
    BOOL created = CreateProcessW(python, command, NULL, NULL, TRUE,
        CREATE_NO_WINDOW, NULL, directory, &startup, &process);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (!created) {
        DWORD error = GetLastError();
        wchar_t details[512];
        _snwprintf(details, 512, L"Windows 错误代码：%lu\n日志：%ls", error, log_file);
        report_error(L"无法启动内置 Python 运行环境。", details);
        CloseHandle(log);
        return 4;
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = 1;
    GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hProcess);
    CloseHandle(log);
    if (exit_code && !wcsstr(arguments, L"--self-test")) {
        report_error(L"程序运行时发生错误，请查看日志。", log_file);
    }
    free(command); free(directory); free(python); free(script);
    free(log_directory); free(log_file);
    return (int)exit_code;
}
