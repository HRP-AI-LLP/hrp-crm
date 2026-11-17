@echo off
rem Starts the HRP Synapse DSC signer (keep this window open while signing).
cd /d "%~dp0"
python dsc_signer.py serve %*
pause
