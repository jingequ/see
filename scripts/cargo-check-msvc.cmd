@echo off
call "C:\Program Files(x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cargo check --manifest-path src-tauri\Cargo.toml
