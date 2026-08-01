@echo off
rem render-check-scheduled.cmd — Task Scheduler wrapper for the render monitor.
rem Runs the 15-view Playwright walk, appends output to a log, and prunes
rem run folders older than 14 days so render-checks\ never bloats.
rem Registered as "Paramount render-check", daily 7:30 AM, start-when-available
rem (fires on wake if the laptop was asleep at trigger time).
cd /d C:\Dev\updates-paramount\paramount-dashboard
echo. >> ..\render-checks\scheduled.log
echo ===== %date% %time% ===== >> ..\render-checks\scheduled.log
node scripts\render-check.mjs >> ..\render-checks\scheduled.log 2>&1
rem prune old runs (best-effort; errors ignored)
forfiles /P ..\render-checks /M RUN_* /D -14 /C "cmd /c if @isdir==TRUE rd /s /q @path" 2>nul
exit /b 0
