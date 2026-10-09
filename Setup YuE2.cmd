@echo off
cd /d "%~dp0"
call npm.cmd ci
if errorlevel 1 goto failed
node scripts/setup.mjs
if errorlevel 1 goto failed
echo.
echo Setup complete. Opening YuE2 Studio...
call "Start YuE2 Studio.cmd"
exit /b
:failed
echo.
echo Setup failed. Check the error above before trying again.
pause
exit /b 1
