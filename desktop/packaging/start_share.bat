@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "MATERIAL_QUOTE_HOME=%~dp0"
set "BOOTSTRAP=%~dp0bootstrap.py"
set "LOGFILE=%~dp0logs\startup.log"
if not exist "%~dp0logs" mkdir "%~dp0logs"
if not exist "%BOOTSTRAP%" goto incomplete
if not exist "%~dp0app\main.py" goto incomplete
if not exist "%~dp0runtime\Lib\site-packages\requests\__init__.py" goto incomplete
if not exist "%~dp0runtime\Lib\site-packages\openpyxl\__init__.py" goto incomplete

echo Checking the included runtime... >"%LOGFILE%"
if not exist "%~dp0runtime\python.exe" goto system
"%~dp0runtime\python.exe" -I -S -X utf8 "%BOOTSTRAP%" --probe >>"%LOGFILE%" 2>&1
if errorlevel 1 goto system
set "RUNPY=%~dp0runtime\python.exe"
set "RUNPYW=%~dp0runtime\pythonw.exe"
goto launch

:system
echo Included runtime was unavailable. Checking installed Python... >>"%LOGFILE%"
for /f "delims=" %%P in ('where python.exe 2^>nul') do (
    call :try_python "%%P"
    if not errorlevel 1 goto found
)
for /f "delims=" %%P in ('where py.exe 2^>nul') do (
    call :try_python "%%P" -3
    if not errorlevel 1 goto found
    call :try_python "%%P" -3.14-64
    if not errorlevel 1 goto found
    call :try_python "%%P" -3.13-64
    if not errorlevel 1 goto found
    call :try_python "%%P" -3.12-64
    if not errorlevel 1 goto found
    call :try_python "%%P" -3.11-64
    if not errorlevel 1 goto found
)
goto missing

:try_python
if /i "%~1"=="%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe" exit /b 1
if not exist "%~1" exit /b 1
"%~1" %2 -I -S -X utf8 "%BOOTSTRAP%" --probe --print-executable >"%~dp0logs\python-path.txt" 2>>"%LOGFILE%"
if errorlevel 1 exit /b 1
set /p "RUNPY="<"%~dp0logs\python-path.txt"
if not defined RUNPY exit /b 1
exit /b 0

:found
for %%P in ("%RUNPY%") do set "RUNPYW=%%~dpPpythonw.exe"
echo Using the installed Python with included application dependencies. >>"%LOGFILE%"

:launch
if /i "%~1"=="--self-test" goto synchronous
if /i "%~1"=="--probe" goto synchronous
if not exist "%RUNPYW%" goto synchronous
start "" "%RUNPYW%" -I -S -X utf8 "%BOOTSTRAP%" %* >>"%~dp0logs\application.log" 2>&1
exit /b 0

:synchronous
"%RUNPY%" -I -S -X utf8 "%BOOTSTRAP%" %*
exit /b %errorlevel%

:missing
echo No compatible 64-bit Python 3.11 or newer with Tk was found.
echo This Windows test-sharing package has not passed installation-free validation.
echo If the included runtime does not start, install 64-bit Python from python.org.
echo The required application libraries are included; pip or network setup is not needed.
echo Details: "%LOGFILE%"
pause
exit /b 1

:incomplete
echo The application directory is incomplete. Extract the entire ZIP and try again.
echo bootstrap.py, app and runtime must remain beside this launcher.
pause
exit /b 2
