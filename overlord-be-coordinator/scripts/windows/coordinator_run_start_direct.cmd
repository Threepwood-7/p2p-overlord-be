@ECHO OFF
CHCP 65001
TITLE VITECOORDINATOR

START "" /MIN /WAIT POWERSHELL.EXE -NoProfile -ExecutionPolicy Bypass -Command ^
"Get-CimInstance Win32_Process ^
| Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*node_modules\vite\bin\vite.js*' } ^
| ForEach-Object { Write-Host ('Killing PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"

TIMEOUT /T 2 >nul

SET CI=true
SET NO_COLOR=1
SET FORCE_COLOR=0
SET npm_config_color=false
SET TERM=dumb


ECHO OVERLORD_PROJECT_DIR = [ %OVERLORD_PROJECT_DIR% ] [ %TIME% ]

CD /D %OVERLORD_PROJECT_DIR%\overlord-be\overlord-be-coordinator

node node_modules\vite\bin\vite.js dev --host 0.0.0.0 --port 13300 --strictPort --logLevel info 1>%OVERLORD_LOG_DIR%\coordinator_stdout.log 2>%OVERLORD_LOG_DIR%\coordinator_stderr.log
