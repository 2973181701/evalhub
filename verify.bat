@echo off
setlocal
chcp 65001 >nul
title EvalHub - Full Verification (stage 0-5)

set "MOONBIN=%USERPROFILE%\.moon\bin"
if not exist "%MOONBIN%\moon.exe" (
  echo [ERROR] MoonBit not found at: %MOONBIN%
  echo Please check your MoonBit installation: https://www.moonbitlang.cn/download/
  pause
  exit /b 1
)
set "PATH=%MOONBIN%;%PATH%"

cd /d "%~dp0"
set "ROOT=%CD%"

echo.
echo ==================================================
echo    EvalHub  -  Full Verification
echo ==================================================
echo    MoonBit dir : %MOONBIN%
echo    Project dir : %ROOT%
echo ==================================================
echo.

echo [1/8] moon version
cd /d "%ROOT%\core"
call moon version
echo.

echo [2/8] moon check        (type check, expect 0 errors)
call moon check
echo.

echo [3/8] moon test         (unit tests, expect 60 passed / 0 failed)
call moon test
echo.

echo [4/8] moon run cmd/main (four engines self-check)
call moon run cmd/main
echo.

echo [5/8] moon build --target js
call moon build --target js
echo.

cd /d "%ROOT%"
echo [6/8] node tools/engine_smoke.mjs   (Node imports the MoonBit engine)
if exist "tools\engine_smoke.mjs" (
  call node tools\engine_smoke.mjs
) else (
  echo [SKIP] tools\engine_smoke.mjs not found.
)
echo.

echo [7/8] node tools/build_dataset.mjs  (real data pipeline -^> data/out/)
if exist "tools\build_dataset.mjs" (
  call node tools\build_dataset.mjs
) else (
  echo [SKIP] tools\build_dataset.mjs not found.
)
echo.

echo [8/8] frontend production build
cd /d "%ROOT%\frontend"
if exist "node_modules" (
  call npx vite build
) else (
  echo [SKIP] frontend\node_modules not found. Run: cd frontend ^&^& npm install
)
cd /d "%ROOT%"
echo.

echo ==================================================
echo    DONE.  Expect 8 sections above.
echo    Pass = no line starting with "Error:" and
echo           moon test reports "failed: 0".
echo.
echo    To run the full stack manually:
echo      1) cd backend  ^&^& npm install ^&^& node server.js
echo      2) cd frontend ^&^& npm install ^&^& npx vite
echo      3) open http://127.0.0.1:5173
echo ==================================================
echo.
pause
