@ECHO OFF

CD /D %~dp0

"%ProgramFiles%\PowerShell\7\pwsh.exe" -NoLogo -NoProfile -File coordinator_run.ps1 debug %*
