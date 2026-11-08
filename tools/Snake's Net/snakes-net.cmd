@echo off
rem Runs Snake's Net straight from this folder (needs Python 3.10+ with psutil and windows-curses).
set "PYTHONPATH=%~dp0;%PYTHONPATH%"
python -m snakes_net %*
