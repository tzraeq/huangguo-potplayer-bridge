@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0HuangguoPotPlayer.exe" (
  echo HuangguoPotPlayer.exe was not found. Extract the full package first.
  pause
  exit /b 1
)
set "HG_BROWSER_DISABLED=%HG_NO_BROWSER%"
set "HG_NO_BROWSER=1"
start "" "%~dp0HuangguoPotPlayer.exe"
set "HG_NO_BROWSER=%HG_BROWSER_DISABLED%"
if "%HG_BROWSER_DISABLED%"=="1" exit /b 0
powershell.exe -NoProfile -WindowStyle Hidden -Command "$url=$null; for($i=0;$i -lt 24 -and -not $url;$i++){ foreach($port in 17891..17899){ try { $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/api/health') -TimeoutSec 1; if($health.appId -eq 'huangguo-potplayer-bridge'){ $url=$health.origin; break } } catch {} }; if(-not $url){ Start-Sleep -Milliseconds 250 } }; if($url){ Start-Process $url; exit 0 }; exit 1"
if errorlevel 1 (
  echo The local service did not start. Run HuangguoPotPlayer.exe directly and try again.
  pause
  exit /b 1
)
endlocal
exit /b 0
