@echo off
rem Starts the Foundry Claude Bridge in its own window. Put a shortcut to this file on the Desktop.
rem If you installed somewhere other than C:\FoundryBridge, change the line below.
set BRIDGE_DIR=C:\FoundryBridge
if not exist "%BRIDGE_DIR%\package.json" (
  echo Can not find the bridge in %BRIDGE_DIR%. Edit this file and set BRIDGE_DIR.
  pause
  exit /b 1
)
start "Foundry Claude Bridge" /D "%BRIDGE_DIR%" cmd /k "%BRIDGE_DIR%\start-bridge.cmd"
