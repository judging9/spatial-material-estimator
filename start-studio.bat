@echo off
setlocal
cd /d "%~dp0"
set "STUDIO_PYTHON=python"
if exist "%~dp0.venv\Scripts\python.exe" set "STUDIO_PYTHON=%~dp0.venv\Scripts\python.exe"
if exist "D:\python\python.exe" set "STUDIO_PYTHON=D:\python\python.exe"
"%STUDIO_PYTHON%" app.py --port 8770 --no-auto-update
if errorlevel 1 pause
endlocal
