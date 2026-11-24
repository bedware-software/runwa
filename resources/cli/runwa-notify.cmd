@echo off
rem Show a notification in a running Runwa. See runwa-notify.ps1 for the options.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0runwa-notify.ps1" %*
exit /b %ERRORLEVEL%
