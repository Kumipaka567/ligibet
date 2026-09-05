@echo off
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /v "^#" backend\.env`) do (
  set "%%a=%%b"
)
node backend\server.js
