@echo off
rem Abre a janela do ajudante (sem console).
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo O ajudante ainda nao foi instalado. Abra "instalar.bat" primeiro.
  pause
  exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" "%~dp0ajudante.pyw"
