#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
int wmain(int argc, wchar_t **argv) {
    for (int i = 1; i < argc; i++) {
        HMODULE module = LoadLibraryW(argv[i]);
        wprintf(L"%ls: %p error %lu\n", argv[i], module, module ? 0 : GetLastError());
    }
    return 0;
}
