@echo off
rem Cria um atalho na pasta Inicializar do Windows: o ajudante abre minimizado ao ligar o PC.
cd /d "%~dp0"
set "ALVO=%~dp0iniciar.bat"
set "ATALHO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Zima Video Ajudante.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ATALHO); $s.TargetPath=$env:ALVO; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if exist "%ATALHO%" (echo Pronto: o ajudante vai abrir sozinho, minimizado, quando o Windows iniciar.) else (echo Nao consegui criar o atalho.)
echo Para desfazer, apague "Zima Video Ajudante" em: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
pause
