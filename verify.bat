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

echo [1/13] moon version
cd /d "%ROOT%\core"
call moon version
echo.

echo [2/13] moon check        (type check, expect 0 errors)
call moon check
echo.

echo [3/13] moon fmt --check  (format check, expect no diff)
echo        NOTE: if it reports "Permission denied" on _build\...\format\,
echo              just run it once more - see docs/坑 33. It is not a code problem.
call moon fmt --check
echo.

echo [4/13] moon test         (unit tests, expect 75 passed / 0 failed)
call moon test
echo.

echo [5/13] moon run cmd/main (four engines self-check)
call moon run cmd/main
echo.

echo [6/13] moon build --target js       (ESM output for Node)
call moon build --target js
echo.

echo [7/13] moon build --target wasm-gc  (self-contained .wasm, 0 imports)
call moon build --target wasm-gc
echo.

cd /d "%ROOT%"
echo [8/13] node tools/engine_smoke.mjs   (Node imports the MoonBit engine)
if exist "tools\engine_smoke.mjs" ( call node tools\engine_smoke.mjs ) else ( echo [SKIP] not found. )
echo.

echo [9/13] node tools/wasm_smoke.mjs     (wasm-gc vs js, expect 64 passed / 0 failed)
if exist "tools\wasm_smoke.mjs" ( call node tools\wasm_smoke.mjs ) else ( echo [SKIP] not found. )
echo.

echo [10/13] node tools/build_dataset.mjs  (real data pipeline -^> data/out/)
if exist "tools\build_dataset.mjs" ( call node tools\build_dataset.mjs ) else ( echo [SKIP] not found. )
echo.

echo [11/13] node tools/audit_numbers.mjs  (doc numbers vs real artifacts, expect 31/0)
if exist "tools\audit_numbers.mjs" ( call node tools\audit_numbers.mjs ) else ( echo [SKIP] not found. )
echo.

echo [12/13] node tools/api_verify.mjs      (12 HTTP endpoints, expect 43/0)
echo         NOTE: this step auto-starts the backend on port 3000,
echo               and restores runtime state when done.
if exist "tools\api_verify.mjs" ( call node tools\api_verify.mjs ) else ( echo [SKIP] not found. )
echo.

echo [13/13] frontend production build
cd /d "%ROOT%\frontend"
if exist "node_modules" (
  call npx vite build
) else (
  echo [SKIP] frontend\node_modules not found. Run: cd frontend ^&^& npm install
)
cd /d "%ROOT%"
echo.

echo ==================================================
echo    DONE.  Expect 13 sections above.
echo.
echo    Pass criteria:
echo      - no line starting with "Error:"
echo      - moon test        : failed: 0        (expect 75 passed)
echo      - wasm_smoke       : 0 failed         (expect 64 passed)
echo      - audit_numbers    : 0 failed         (expect 31 passed)
echo      - api_verify       : 0 failed         (expect 43 passed)
echo.
echo    To run the full stack manually:
echo      1) cd backend  ^&^& npm install ^&^& node server.js
echo      2) cd frontend ^&^& npm install ^&^& npx vite
echo      3) open http://127.0.0.1:5173
echo ==================================================
echo.
pause
