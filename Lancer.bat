@echo off
rem Alternative au double-clic sur index.html : sert l'éditeur sur http://localhost:8765
cd /d "%~dp0"
start "" http://localhost:8765/index.html
python -m http.server 8765
