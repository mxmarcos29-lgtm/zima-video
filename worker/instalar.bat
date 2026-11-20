@echo off
setlocal
cd /d "%~dp0"
echo ==================================================
echo   Zima Video - Ajudante: instalacao
echo ==================================================
echo.

rem --- procura um Python 3.10 a 3.13 (instala o 3.12 pelo winget se nao tiver)
set PY=
for %%V in (3.12 3.11 3.13 3.10) do (
  if not defined PY (
    py -%%V -c "import tkinter" >nul 2>nul && set PY=py -%%V
  )
)
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY (
  echo Python nao encontrado. Instalando o Python 3.12 pelo winget...
  winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
  set PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)
echo Usando: %PY%

rem --- ambiente isolado so para o ajudante
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv || goto :erro
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :erro

rem --- atalhos na area de trabalho e no menu Iniciar
set "ALVO=%~dp0.venv\Scripts\pythonw.exe"
set "APPF=%~dp0ajudante.pyw"
set "DIRF=%~dp0"
powershell -NoProfile -Command "foreach($p in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))){ $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $p 'Zima Video Ajudante.lnk')); $s.TargetPath=$env:ALVO; $s.Arguments='\"' + $env:APPF + '\"'; $s.WorkingDirectory=$env:DIRF; $s.Description='Zima Video Ajudante'; $s.Save() }"

echo.
echo Instalacao concluida! Abrindo o ajudante...
echo (Depois, use o atalho "Zima Video Ajudante" na area de trabalho ou no menu Iniciar.)
start "" "%ALVO%" "%APPF%"
timeout /t 5 >nul
exit /b 0

:erro
echo.
echo Algo deu errado. Veja a mensagem acima (ou rode instalar.bat de novo).
pause
exit /b 1
