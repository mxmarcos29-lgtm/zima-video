@echo off
rem Faz o ajudante abrir sozinho (escondido na bandeja, perto do relogio) quando o Windows iniciar.
rem A mesma opcao existe na janela do ajudante: "Abrir junto com o Windows".
cd /d "%~dp0"
set "ALVO=%~dp0.venv\Scripts\pythonw.exe"
set "APPF=%~dp0ajudante.pyw"
set "DIRF=%~dp0"
set "ATALHO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Zima Video Ajudante.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ATALHO); $s.TargetPath=$env:ALVO; $s.Arguments='\"' + $env:APPF + '\" --bandeja'; $s.WorkingDirectory=$env:DIRF; $s.Save()"
if exist "%ATALHO%" (echo Pronto: o ajudante vai abrir sozinho, na bandeja, quando o Windows iniciar.) else (echo Nao consegui criar o atalho.)
echo Para desfazer, desmarque "Abrir junto com o Windows" na janela do ajudante.
pause
