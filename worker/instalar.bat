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
    py -%%V -c "import sys" >nul 2>nul && set PY=py -%%V
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

rem --- configura endereco e codigo e baixa os modelos
".venv\Scripts\python.exe" zima_worker.py --setup || goto :erro

echo.
echo Instalacao concluida! Para comecar, abra "iniciar.bat".
pause
exit /b 0

:erro
echo.
echo Algo deu errado. Veja a mensagem acima (ou rode instalar.bat de novo).
pause
exit /b 1
