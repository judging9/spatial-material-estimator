@echo off
where pythonw.exe >nul 2>nul
if errorlevel 1 (
  echo Python 3 with Tkinter is required for source mode.
  echo Use the complete desktop\dist portable application instead.
  pause
  exit /b 1
)
start "" /d "%~dp0.." pythonw.exe "%~dp0..\main.py" %*
