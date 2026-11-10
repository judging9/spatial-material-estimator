The offline distribution is built with:

```powershell
python desktop/packaging/build_portable.py --self-test
```

The build copies the installed Windows Python 3.11 runtime, Tk/Tcl, and the
installed requests/openpyxl dependency closure into `desktop/dist/runtime`.
It compiles `launcher.c` with GCC and copies the application into `dist/app`.
The application uses `MATERIAL_QUOTE_HOME`, set by the launcher to the directory
containing the executable, so projects and materials are kept in `dist/data`.
Application output is captured in `dist/logs/launcher.log`.

After editing the application, refresh only its files with:

```powershell
python desktop/packaging/build_portable.py --refresh-app --self-test
```

Some managed Windows environments reject DLL initialization in newly copied
interpreter processes. The launcher probes the included runtime and can use
an installed `pythonw.exe` as a compatibility fallback. If validation is
blocked in such an environment, `--allow-system-fallback` keeps the files and
records the limitation in `dist/VALIDATION.json`; it does not mean the included
interpreter or launcher has passed startup validation. A clean Windows x64
machine must still be used to validate the standalone distribution.

`start_desktop.bat` starts the source application with an installed Python.
Source application dependencies are `requests` and `openpyxl`, plus Python's
standard Tkinter. No files are installed outside the workspace by this build.
