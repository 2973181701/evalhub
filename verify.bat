@echo off
setlocal
chcp 65001 >nul
title EvalHub - Stage 0/1 Verification

set "MOONBIN=%USERPROFILE%\.moon\bin"
if not exist "%MOONBIN%\moon.exe" (
  echo [ERROR] MoonBit not found at: %MOONBIN%
  echo Please check your MoonBit installation.
  pause
  exit /b 1
)
set "PATH=%MOONBIN%;%PATH%"

cd /d "%~dp0core"
if errorlevel 1 (
  echo [ERROR] Cannot enter the core directory.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo    EvalHub  -  Stage 0/1 Verification
echo ==================================================
echo    MoonBit dir : %MOONBIN%
echo    Project dir : %CD%
echo ==================================================
echo.

echo [1/6] moon version
call moon version
echo.

echo [2/6] moon check
call moon check
echo.

echo [3/6] moon test
call moon test
echo.

echo [4/6] moon run cmd/main
call moon run cmd/main
echo.

echo [5/6] moon build --target js
call moon build --target js
echo.

cd /d "%~dp0"
echo [6/6] node tools/engine_smoke.mjs  (Node imports the MoonBit engine)
if exist "tools\engine_smoke.mjs" (
  call node tools\engine_smoke.mjs
) else (
  echo [SKIP] tools\engine_smoke.mjs not found.
)
echo.

echo ==================================================
echo    DONE.  Expect 6 sections above.
echo    Pass = no line starting with "Error:"
echo ==================================================
echo.
pause
