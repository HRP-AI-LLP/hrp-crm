# HRP Synapse DSC signer (USB token)

Signs documents from your Synapse with a digital signature certificate (DSC) kept on a USB token
(ePass2003, ProxKey, Watchdata, HyperPKI, SafeNet …). The key never leaves the token; the PIN is typed in
Synapse and goes only to this signer on your own computer, never to the server.

It signs only for the Synapse it is paired with:

- it answers only web pages from that Synapse address (other websites get "403");
- every signature needs a ticket that your Synapse made, with the pairing secret, for that exact PDF and
  that certificate, valid for 10 minutes;
- Synapse checks the signed PDF (valid signature, the registered certificate, the document unchanged)
  before keeping it with the record.

## Set up (once, on the computer with the token)

1. Install the token's driver from its maker (this installs its PKCS#11 library, e.g.
   `C:\Windows\System32\eps2003csp11v2.dll` for ePass2003).
2. Have Python 3.10 or newer (3.12–3.14 are fine). Nothing else to install by hand:
   - **On your development computer, `pnpm local` (or `pnpm local:cloud`) does everything**: the first time
     it installs the signer's packages into `tools/dsc-signer/.deps` and then starts the signer in the
     background with the app (lines marked `[dsc]`). `pnpm local --no-signer` or `DSC_SIGNER=off` skips it.
   - On another computer that only signs, double-click `start-signer.bat`; it does the same.
   - To install by hand: `pnpm dsc install` (from the project folder), or in this folder
     `python -m pip install --target .deps -r requirements.txt`.

   Packages are installed with `python -m pip`, never `pip.exe`, so Windows application-control policies
   that block `pip.exe` (“An Application Control policy has blocked this file”) don't get in the way.
3. In Synapse: Organisation → **Digital signatures (DSC)** → **Pair a signer**. It shows a command with a
   one-time code; run it once. On your development computer that is

   ```
   pnpm dsc pair <code> --origin http://localhost:5173 --origin http://localhost:8787
   ```

   (elsewhere: `python dsc_signer.py pair <code> --origin https://your-synapse-address`). A running signer
   picks up the pairing at once.
4. Plug in the token. In Synapse, **Add the token's certificate**: Synapse reads the certificate from the
   token through the signer (enter the PIN if the token asks for it) and you choose who may sign with it.
   If the signer says no driver was found, start it once with the driver's path:
   `pnpm dsc serve --lib "C:\Windows\System32\eps2003csp11v2.dll"` (remembered from then on).

## Signing

Open an issued invoice (or a quote, order or purchase order) → Signatures → **Sign with DSC (token)**,
enter the token PIN. The signed PDF is kept on the record (Files) and can be downloaded and sent; it shows
as signed in Adobe Reader. If Adobe says the signer's identity is unknown, add the CCA India root
certificate (from your DSC provider) to Adobe's trusted certificates once.

## Notes

- `python dsc_signer.py certs --pin <PIN>` lists the certificates on the token.
- The settings (pairings, library path) are in `~/.synapse-dsc-signer.json`; delete the file to unpair.
  Unpairing in Synapse (remove the signer) stops it at once.
- Too many wrong PINs lock the token; unlock it with the maker's tool.

## Troubleshooting

- **“An Application Control policy has blocked this file” for pip.exe**: use `pnpm dsc install` or
  `python -m pip …` as above. If Python itself (`python.exe`) is blocked too, ask your IT team to allow
  Python, or install it from the Microsoft Store / python.org into `C:\Program Files`.
- **`[dsc] Port 47321 is in use`**: a signer is already running (for example from `start-signer.bat`);
  that one is used.
- **“No driver (PKCS#11 library) for the token was found”**: install the token's driver, or pass `--lib`.
