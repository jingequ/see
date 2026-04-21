@echo off
call "C:\Program Files(x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d D:\workspace\see
call "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" run tauri:dev -- "D:\workspace\see\test-image.png"
