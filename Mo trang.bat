@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
rem May chi cai launcher "py" (khong co lenh "python") van chay duoc
python --version >nul 2>nul
if %errorlevel%==0 (
  python serve.py
) else (
  py --version >nul 2>nul
  if errorlevel 1 (
    echo Chua cai Python. Tai tai https://www.python.org/downloads/ ^(nho tick "Add python.exe to PATH"^)
  ) else (
    py serve.py
  )
)
pause
