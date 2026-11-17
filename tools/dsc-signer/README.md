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
2. Install Python 3.10+ and the signer's library:

   ```
   pip install -r requirements.txt
   ```

3. In Synapse: Settings → Organisation → **Digital signatures** → **Pair a signer**. Copy the pairing
   code it shows (it is shown once), then:

   ```
   python dsc_signer.py pair <pairing code> --origin http://localhost:8787
   ```

   Use your Synapse address as the origin (the address in the browser, without a path).
4. Start the signer (double-click `start-signer.bat` on Windows, or):

   ```
   python dsc_signer.py serve --lib "C:\Windows\System32\eps2003csp11v2.dll"
   ```

   `--lib` is remembered; it is needed only the first time, or when the library isn't in the usual places.
5. In Synapse, **Add the token's certificate**: with the signer running and the token plugged in, Synapse
   reads the certificate from the token (enter the PIN if the token asks for it) and you name who may sign
   with it.

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
