@echo off
rem Starts the SanchalanOS DSC signer (keep this window open while signing).
rem pnpm local starts it for you; this is for computers that only sign.
rem Needs only Python and the token driver: nothing to install.
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py -3
%PY% dsc_signer.py serve %*
pause
