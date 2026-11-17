#!/usr/bin/env python3
"""
HRP Synapse DSC signer: signs PDFs with a digital signature certificate on a USB token (ePass2003,
ProxKey, Watchdata, HyperPKI …) for your Synapse workspace only.

The key never leaves the token. Synapse asks this signer to sign one PDF at a time with a ticket it
made with the pairing secret; the signer checks the ticket (made by your workspace, for this exact PDF,
this certificate, not expired), asks for nothing else, and returns the signed PDF. Requests from other
websites are refused, and requests without a valid ticket are refused.

    python dsc_signer.py pair <pairing code> --origin https://yourco.synapse.example [--origin …]
    python dsc_signer.py serve [--lib "C:\\Windows\\System32\\eps2003csp11v2.dll"]
    python dsc_signer.py certs --lib ... --pin ...        (lists the certificates on the token)

Needs Python 3.10+ and the packages in requirements.txt. They can live in the .deps folder beside this
file (`python -m pip install --target .deps -r requirements.txt`, which `pnpm local` does for you), so
no pip.exe or other new program has to run.
"""
from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

# packages installed beside the signer (python -m pip install --target .deps …) come first
_DEPS = _Path(__file__).resolve().parent / ".deps"
if _DEPS.is_dir() and str(_DEPS) not in _sys.path:
    _sys.path.insert(0, str(_DEPS))

# Windows consoles and pipes default to a code page (cp1252) that cannot print every character, e.g. a
# certificate holder's name in Devanagari: print UTF-8, and never crash on a character that won't show
for _stream in (_sys.stdout, _sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

import argparse
import base64
import hashlib
import hmac
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.1.0"

# pyHanko reads the computer's time zone; some settings (e.g. "Asia/Calcutta" as TZ) can't be read
# that way. Fall back to UTC for the signing time then (the time in the PDF signature is absolute).
try:
    import tzlocal

    tzlocal.get_localzone()
except Exception:  # noqa: BLE001
    try:
        import datetime as _dt

        import tzlocal

        tzlocal.get_localzone = lambda: _dt.timezone.utc  # type: ignore[assignment]
    except ImportError:
        pass
CONFIG = Path(os.environ.get("SYNAPSE_DSC_CONFIG", Path.home() / ".synapse-dsc-signer.json"))
DEFAULT_PORT = 47321
# where token makers install their PKCS#11 library (Windows; tried in this order)
KNOWN_LIBS = [
    r"C:\Windows\System32\eps2003csp11v2.dll",  # ePass2003 (v2)
    r"C:\Windows\System32\eps2003csp11.dll",  # ePass2003
    r"C:\Windows\System32\SignatureP11.dll",  # ProxKey
    r"C:\Windows\System32\WDPKCS.dll",  # Watchdata
    r"C:\Windows\System32\wdpkcs_icp.dll",  # Watchdata ICP
    r"C:\Windows\System32\CryptoIDA_pkcs11.dll",  # Gemalto / Thales
    r"C:\Windows\System32\eToken.dll",  # SafeNet eToken
    r"C:\Windows\System32\HypersecuP11.dll",  # HyperPKI
    "/usr/lib/libeps2003csp11.so",
    "/usr/lib/softhsm/libsofthsm2.so",
]
lock = threading.Lock()  # one token operation at a time


def load_config() -> dict:
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {"pairings": [], "lib": None, "port": DEFAULT_PORT}


def save_config(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG, 0o600)
    except OSError:
        pass


NO_LIB = "No driver (PKCS#11 library) for the token was found. Install the token's driver, or start the signer with --lib and its .dll path."


def find_lib(cfg: dict, override: str | None, required: bool = True) -> str | None:
    for cand in [override, cfg.get("lib"), *KNOWN_LIBS]:
        if cand and Path(cand).exists():
            return cand
    if required:
        raise SystemExit(NO_LIB)
    return None


def origins_of(pairing: dict) -> set[str]:
    return {o.rstrip("/") for o in [pairing.get("origin"), *pairing.get("origins", [])] if o}


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def check_ticket(cfg: dict, ticket: str, pdf: bytes) -> dict:
    """The ticket must come from a paired workspace and name exactly this PDF."""
    try:
        body, mac = ticket.split(".")
        payload = json.loads(b64url_decode(body))
    except Exception:
        raise PermissionError("Malformed ticket")
    pairing = next((p for p in cfg["pairings"] if p["tenant"] == payload.get("t") and p["signer"] == payload.get("s")), None)
    if not pairing:
        raise PermissionError("This signer is not paired with that workspace")
    good = hmac.new(pairing["secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(good, mac):
        raise PermissionError("The ticket was not made by the paired workspace")
    if payload.get("exp", 0) < time.time():
        raise PermissionError("The ticket expired: sign again from Synapse")
    if hashlib.sha256(pdf).hexdigest() != payload.get("h") or len(pdf) != payload.get("l"):
        raise PermissionError("The PDF is not the one the ticket is for")
    return payload


def open_session(lib: str, pin: str | None):
    """A session on the plugged-in token (the first initialised token that holds a certificate)."""
    import pkcs11
    from pkcs11 import Attribute, ObjectClass, TokenFlag

    tokens = list(pkcs11.lib(lib).get_tokens(token_flags=TokenFlag.TOKEN_INITIALIZED))
    if not tokens:
        raise RuntimeError("No token is plugged in")
    for token in tokens:
        session = token.open(user_pin=pin) if pin else token.open()
        if any(True for _ in session.get_objects({Attribute.CLASS: ObjectClass.CERTIFICATE})):
            return session
        session.close()
    raise RuntimeError("No certificate found on the token")


def pem_of(der: bytes) -> str:
    b = base64.b64encode(der).decode()
    return "-----BEGIN CERTIFICATE-----\n" + "\n".join(b[i:i + 64] for i in range(0, len(b), 64)) + "\n-----END CERTIFICATE-----\n"


def token_certs(lib: str, pin: str | None):
    from pkcs11 import Attribute, ObjectClass

    session = open_session(lib, pin)
    out = []
    try:
        for obj in session.get_objects({Attribute.CLASS: ObjectClass.CERTIFICATE}):
            der = bytes(obj[Attribute.VALUE])
            out.append({"id": bytes(obj[Attribute.ID]).hex(), "label": obj[Attribute.LABEL], "thumbprint": hashlib.sha1(der).hexdigest(), "pem": pem_of(der)})
    finally:
        session.close()
    return out


def sign_pdf(lib: str, pin: str, pdf: bytes, payload: dict) -> bytes:
    from pkcs11 import Attribute, ObjectClass
    from pyhanko import stamp
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.sign.pkcs11 import PKCS11Signer

    session = open_session(lib, pin)
    try:
        cert_id = None
        for obj in session.get_objects({Attribute.CLASS: ObjectClass.CERTIFICATE}):
            if hashlib.sha1(bytes(obj[Attribute.VALUE])).hexdigest() == payload["c"]:
                cert_id = bytes(obj[Attribute.ID])
        if cert_id is None:
            raise PermissionError("The certificate Synapse asked for is not on this token")
        signer = PKCS11Signer(session, cert_id=cert_id, key_id=cert_id)
        writer = IncrementalPdfFileWriter(io.BytesIO(pdf))
        meta = signers.PdfSignatureMetadata(field_name=f"Synapse{int(time.time())}", reason=payload.get("reason") or "Signed", md_algorithm="sha256")
        text = "\n".join(payload.get("stamp") or ["Digitally signed"])
        style = stamp.TextStampStyle(stamp_text=text.replace("%", "%%"), border_width=1)
        # bottom right of the last page
        spec = fields.SigFieldSpec(meta.field_name, on_page=-1, box=(330, 20, 575, 82))
        out = signers.PdfSigner(meta, signer=signer, stamp_style=style, new_field_spec=spec).sign_pdf(writer)
        return out.getvalue()
    finally:
        session.close()


class Handler(BaseHTTPRequestHandler):
    server_version = f"SynapseDSC/{VERSION}"

    def _origin_ok(self) -> str | None:
        origin = self.headers.get("Origin")
        cfg = load_config()
        allowed = set().union(*(origins_of(p) for p in cfg["pairings"])) if cfg["pairings"] else set()
        return origin if origin and origin.rstrip("/") in allowed else None

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        origin = self._origin_ok()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):  # CORS preflight, incl. Chrome's private network access
        origin = self._origin_ok()
        self.send_response(204 if origin else 403)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"error": "This signer only answers your paired Synapse"})
        if self.path == "/v1/status":
            cfg = load_config()
            return self._send(200, {"ok": True, "version": VERSION, "driver": bool(self._lib(cfg, False)), "signers": [{"tenant": p["tenant"], "signer": p["signer"]} for p in cfg["pairings"]]})
        self._send(404, {"error": "not found"})

    def _lib(self, cfg: dict, required: bool = True) -> str | None:
        # looked up on each request: the driver may be installed while the signer runs
        lib = find_lib(cfg, getattr(self.server, "lib_override", None), required=False)
        if not lib and required:
            raise LookupError(NO_LIB)
        return lib

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 40 * 1024 * 1024:
            raise ValueError("Too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"error": "This signer only answers your paired Synapse"})
        cfg = load_config()
        try:
            body = self._body()
            if self.path == "/v1/certificates":
                with lock:
                    return self._send(200, {"certificates": token_certs(self._lib(cfg), body.get("pin"))})
            if self.path == "/v1/sign":
                pdf = base64.b64decode(body["pdf"])
                payload = check_ticket(cfg, body["ticket"], pdf)
                if not body.get("pin"):
                    return self._send(400, {"error": "Enter the token PIN"})
                with lock:
                    signed = sign_pdf(self._lib(cfg), body["pin"], pdf, payload)
                return self._send(200, {"pdf": base64.b64encode(signed).decode()})
            self._send(404, {"error": "not found"})
        except PermissionError as e:
            self._send(403, {"error": str(e)})
        except LookupError as e:
            self._send(503, {"error": str(e)})
        except Exception as e:  # token errors: wrong PIN, locked token, unplugged …
            msg = type(e).__name__
            if "PinIncorrect" in msg:
                msg = "Wrong PIN (too many wrong PINs lock the token)"
            elif "PinLocked" in msg:
                msg = "The token is locked: unlock it with the maker's tool"
            elif "NoSuchToken" in msg or "TokenNotPresent" in msg:
                msg = "No token is plugged in"
            else:
                msg = f"{msg}: {e}"
            self._send(500, {"error": msg})

    def log_message(self, fmt, *args):  # quiet; never logs PINs or documents
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    ap = argparse.ArgumentParser(description="HRP Synapse DSC signer (USB token)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pair", help="pair with a Synapse workspace (code from Organisation > Digital signatures)")
    p.add_argument("code")
    p.add_argument("--origin", required=True, action="append", help="your Synapse address, e.g. https://acme.synapse.example or http://localhost:8787 (repeat for several)")
    s = sub.add_parser("serve", help="run the signer")
    s.add_argument("--lib", help="the token's PKCS#11 library (.dll / .so)")
    s.add_argument("--port", type=int, default=None)
    c = sub.add_parser("certs", help="list the certificates on the token")
    c.add_argument("--lib")
    c.add_argument("--pin")
    a = ap.parse_args()
    cfg = load_config()
    if a.cmd == "pair":
        import re

        m = re.fullmatch(r"([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})", a.code.strip())
        if not m:
            raise SystemExit(
                "That is not a pairing code. In Synapse open Organisation > Digital signatures (DSC) > Pair a signer,\n"
                "then copy the whole command it shows (it starts with: pnpm dsc pair) and run it here."
            )
        tenant, signer, secret = m.groups()
        cfg["pairings"] = [x for x in cfg["pairings"] if not (x["tenant"] == tenant and x["signer"] == signer)]
        origins = sorted({o.rstrip("/") for o in a.origin})
        cfg["pairings"].append({"tenant": tenant, "signer": signer, "secret": secret, "origin": origins[0], "origins": origins})
        save_config(cfg)
        print(f"Paired with {', '.join(origins)}. A running signer picks this up at once; otherwise start it (pnpm local starts it for you).")
    elif a.cmd == "certs":
        for x in token_certs(find_lib(cfg, a.lib), a.pin):
            print(f"{x['label']}  sha1={x['thumbprint']}")
    elif a.cmd == "serve":
        if a.lib:
            if not Path(a.lib).exists():
                raise SystemExit(f"{a.lib} does not exist")
            cfg["lib"] = a.lib
            save_config(cfg)
        lib = find_lib(cfg, a.lib, required=False)
        port = a.port or cfg.get("port") or DEFAULT_PORT
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        except OSError:
            raise SystemExit(f"Port {port} is in use: the signer is probably already running.")
        srv.lib_override = a.lib  # type: ignore[attr-defined]
        origins = sorted(set().union(*(origins_of(p) for p in cfg["pairings"]))) if cfg["pairings"] else []
        print(f"Synapse DSC signer {VERSION} on http://127.0.0.1:{port}")
        print(f"  token driver: {lib or 'not found yet (install the token driver, or pass --lib)'}")
        print(f"  answering:    {', '.join(origins) if origins else 'nobody yet: pair it from Organisation > Digital signatures'}")
        srv.serve_forever()


if __name__ == "__main__":
    main()
