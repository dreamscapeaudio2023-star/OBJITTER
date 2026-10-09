@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules\ws (
  call npm install --omit=dev || (echo npm install failed & pause & exit /b 1)
)
if "%PORT%"=="" set PORT=8080
set "PORTCHK="
for /f "delims=0123456789" %%A in ("%PORT%") do set "PORTCHK=%%A"
if defined PORTCHK goto badport
if %PORT% LSS 1 goto badport
if %PORT% GTR 65535 goto badport
goto portok
:badport
echo [objitter] PORT="%PORT%" is not a valid port number (1-65535). Using 8080.
set PORT=8080
:portok
rem Open the browser only once the server answers (avoids a "can't connect" page on slow starts).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%);$c.Close();Start-Process 'http://localhost:%PORT%';break}catch{Start-Sleep -Milliseconds 500}}"
node server\index.js
pause
