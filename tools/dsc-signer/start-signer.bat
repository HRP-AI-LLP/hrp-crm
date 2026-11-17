@echo off
rem Starts the HRP Synapse DSC signer (keep this window open while signing).
rem pnpm local starts it for you; this is for computers that only sign.
rem Packages go into the .deps folder with "python -m pip", so no pip.exe has to run.
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py -3
if not exist ".deps\.installed" (
  echo Installing the signer's packages into .deps (once^) ...
  %PY% -m pip install --disable-pip-version-check --no-warn-script-location --upgrade --target .deps -r requirements.txt || goto :failed
  echo ok> ".deps\.installed"
)
%PY% dsc_signer.py serve %*
pause
exit /b
:failed
echo Installing failed. See README.md (Troubleshooting).
pause
