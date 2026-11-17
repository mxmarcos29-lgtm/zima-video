@echo off
cd /d "%~dp0"
title Zima Video - Ajudante
if not exist ".venv\Scripts\python.exe" (
  echo Rode primeiro o instalar.bat
  pause
  exit /b 1
)
".venv\Scripts\python.exe" zima_worker.py %*
pause
