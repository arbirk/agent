@echo off
setlocal

:: Check if help was requested
if "%~1"=="-h" goto run
if "%~1"=="--help" goto run
if "%~1"=="-?" goto run

:: Prompt for Bearer token
set "BEARER_TOKEN="
set /p "BEARER_TOKEN=Bearer token (press Enter to leave empty): "

if not "%BEARER_TOKEN%"=="" (
    set "LLM_API_KEY=%BEARER_TOKEN%"
) else (
    set "LLM_API_KEY="
)

:run
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%src\cli.js" --workspace "%CD%" %*
exit /b %ERRORLEVEL%
