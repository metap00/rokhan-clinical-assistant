@echo off
rem Start Rokhan on this PC and open it in the browser. Local testing only, password "demo": a server uses deploy\rokhan.service.
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist .env (echo ROKHAN_PASSWORD=demo> .env)
start "" http://localhost:8787
node --env-file-if-exists=.env server/index.mjs
pause
