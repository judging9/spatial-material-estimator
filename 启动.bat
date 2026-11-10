@echo off
chcp 936 >nul
cd /d "%~dp0"
title 材料报价系统

echo ============================================
echo            材料报价系统  启动中
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 python，请先安装 Python 3.9 以上版本，
  echo        安装时勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

python -c "import requests, openpyxl" >nul 2>nul
if errorlevel 1 (
  echo [提示] 首次运行需要安装两个依赖，正在安装...
  python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple requests openpyxl
  echo.
)

rem 已经有实例在跑就别再起一个：两个进程抢同一端口会出各种怪问题
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',8765);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto already

echo 正在启动，浏览器会自动打开 http://127.0.0.1:8765
echo 关闭本窗口即可退出程序。
echo.
python app.py
set "CODE=%errorlevel%"
if not "%CODE%"=="0" (
  echo.
  echo [提示] 程序退出，代码 %CODE%。
  echo        如果是端口被占用，可以改用：python app.py --port 8766
  pause
)
exit /b 0

:already
echo [提示] 检测到程序已经在运行，直接为你打开浏览器。
start "" http://127.0.0.1:8765
exit /b 0
