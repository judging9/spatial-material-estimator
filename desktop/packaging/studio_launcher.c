/* Windows desktop entry point for the bundled, isolated Python runtime.
 * No PATH interpreter or installed Python is used.
 * Compile with gcc -municode -mwindows -static-libgcc.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>

#define CAPACITY 32768

static void report(const wchar_t *message, const wchar_t *detail) {
    wchar_t text[2048];
    _snwprintf(text, 2047, L"%ls\n\n%ls", message, detail ? detail : L"");
    text[2047] = L'\0';
    HMODULE library = LoadLibraryW(L"user32.dll");
    if (library) {
        typedef int (WINAPI *ShowMessage)(HWND, LPCWSTR, LPCWSTR, UINT);
        ShowMessage show = (ShowMessage)GetProcAddress(library, "MessageBoxW");
        if (show) show(NULL, text, L"空间材料估算", MB_OK | MB_ICONERROR);
        FreeLibrary(library);
    }
    OutputDebugStringW(text);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    (void)instance; (void)previous; (void)show;
    wchar_t *root = calloc(CAPACITY, sizeof(wchar_t));
    wchar_t *python = calloc(CAPACITY, sizeof(wchar_t));
    wchar_t *script = calloc(CAPACITY, sizeof(wchar_t));
    wchar_t *data = calloc(CAPACITY, sizeof(wchar_t));
    wchar_t *log_path = calloc(CAPACITY, sizeof(wchar_t));
    wchar_t *temp_path = calloc(CAPACITY, sizeof(wchar_t));
    if (!root || !python || !script || !data || !log_path || !temp_path) return 1;
    DWORD length = GetModuleFileNameW(NULL, root, CAPACITY);
    wchar_t *slash = wcsrchr(root, L'\\');
    if (!length || length >= CAPACITY - 100 || !slash) return 1;
    *slash = L'\0';
    _snwprintf(python, CAPACITY, L"%ls\\runtime\\pythonw.exe", root);
    _snwprintf(script, CAPACITY, L"%ls\\app\\studio_launcher.py", root);
    if (GetFileAttributesW(python) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
        report(L"程序文件不完整，请重新解压整个软件目录。", L"请保留程序同目录的 app 和 runtime 文件夹。");
        return 2;
    }
    DWORD local_length = GetEnvironmentVariableW(L"PLANMATTER_DATA_DIR", data, CAPACITY);
    if (!local_length || local_length >= CAPACITY - 80) {
        local_length = GetEnvironmentVariableW(L"LOCALAPPDATA", data, CAPACITY);
        if (!local_length || local_length >= CAPACITY - 80) {
            report(L"无法确定本地数据目录。", L"请检查 Windows 用户配置后重试。");
            return 3;
        }
        wcscat(data, L"\\PlanMatter");
    }
    CreateDirectoryW(data, NULL);
    _snwprintf(temp_path, CAPACITY, L"%ls\\cache", data);
    CreateDirectoryW(temp_path, NULL);
    wcscat(temp_path, L"\\temp");
    CreateDirectoryW(temp_path, NULL);
    if (GetFileAttributesW(temp_path) == INVALID_FILE_ATTRIBUTES) {
        report(L"无法创建本地缓存目录。", temp_path);
        return 4;
    }
    /* Temporary files belong to this user's application data as well. These
     * environment changes apply only to this launch and its child process. */
    SetEnvironmentVariableW(L"TEMP", temp_path);
    SetEnvironmentVariableW(L"TMP", temp_path);
    _snwprintf(log_path, CAPACITY, L"%ls\\logs", data);
    CreateDirectoryW(log_path, NULL);
    wcscat(log_path, L"\\launcher.log");
    SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
    HANDLE log = CreateFileW(log_path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (log == INVALID_HANDLE_VALUE) {
        report(L"无法写入本地日志。", log_path);
        return 4;
    }
    SetFilePointer(log, 0, NULL, FILE_END);
    const char marker[] = "\r\n--- PlanMatter 1.3.0 ---\r\n";
    DWORD written;
    WriteFile(log, marker, sizeof(marker) - 1, &written, NULL);
    HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    /* Use Windows process arguments directly. No shell evaluates paths or
     * user arguments, and -I prevents system Python packages being imported. */
    size_t capacity = wcslen(python) + wcslen(script) + wcslen(arguments) + 64;
    if (capacity > CAPACITY) {
        CloseHandle(input);
        CloseHandle(log);
        report(L"启动参数过长，请缩短程序或数据目录路径。", L"");
        return 6;
    }
    wchar_t *command = calloc(capacity, sizeof(wchar_t));
    if (!command) return 1;
    _snwprintf(command, capacity, L"\"%ls\" -I -X utf8 -u \"%ls\" %ls", python, script, arguments);
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    /* A hidden GUI launcher may inherit a noninteractive desktop. Explicitly
     * use the signed-in user's desktop so system GUI DLLs can initialize;
     * CREATE_NO_WINDOW and SW_HIDE still prevent a console from appearing. */
    startup.lpDesktop = L"winsta0\\default";
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = input;
    startup.hStdOutput = log;
    startup.hStdError = log;
    PROCESS_INFORMATION process = {0};
    BOOL created = CreateProcessW(python, command, NULL, NULL, TRUE, CREATE_NO_WINDOW,
                                 NULL, root, &startup, &process);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    DWORD code = 1;
    if (created) {
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        GetExitCodeProcess(process.hProcess, &code);
        CloseHandle(process.hProcess);
    } else {
        code = GetLastError();
        const char failure[] = "Unable to start bundled runtime.\r\n";
        WriteFile(log, failure, sizeof(failure) - 1, &written, NULL);
    }
    CloseHandle(log);
    if (code && !wcsstr(arguments, L"--self-test"))
        report(L"软件未能启动，请查看运行日志。", log_path);
    free(command); free(root); free(python); free(script); free(data); free(log_path); free(temp_path);
    return (int)code;
}
