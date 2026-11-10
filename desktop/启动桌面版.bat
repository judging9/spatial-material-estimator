@echo off
setlocal
cd /d "%~dp0"
set "MATERIAL_QUOTE_HOME=%~dp0"
where pythonw.exe >nul 2>nul
if errorlevel 1 goto console
start "" pythonw.exe "%~dp0main.py" %*
exit /b 0
:console
where python.exe >nul 2>nul
if errorlevel 1 goto missing
python.exe "%~dp0main.py" %*
if errorlevel 1 pause
exit /b
:missing
echo Python 3 with tkinter, requests and openpyxl is required for this source launcher.
echo Use the complete packaged distribution in the dist folder instead.
pause
exit /b 1
