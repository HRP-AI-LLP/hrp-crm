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

Needs only Python 3.10+ and the token maker's driver: no packages to install. The token is reached
through Python's own ctypes, so application-control policies that block unsigned add-on files do not
apply. Synapse prepares the PDF; the signer only signs its 32-byte digest, and only with a ticket.
"""
from __future__ import annotations

import sys as _sys

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
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "2.0.0"

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


def check_ticket(cfg: dict, ticket: str) -> dict:
    """The ticket must come from a paired workspace, be fresh, and name a 32-byte digest to sign."""
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
    if payload.get("v") != 2 or len(bytes.fromhex(payload.get("d", ""))) != 32:
        raise PermissionError("This ticket is from another version of Synapse: reload the page and sign again")
    return payload


# ───────────────────────── PKCS#11 through ctypes (no packages, no compiled add-ons) ─────────────────────────
#
# Only Python's own ctypes and the token maker's driver are loaded, so application-control policies that
# block unsigned add-on files (.pyd) do not get in the way. Structures follow the PKCS#11 headers: on
# Windows they are packed to 1 byte and CK_ULONG is 32-bit; elsewhere natural alignment.

import ctypes

_WIN = os.name == "nt"
CK_ULONG = ctypes.c_ulong
_PACK = 1 if _WIN else 0

CKF_SERIAL_SESSION = 0x4
CKU_USER = 1
CKA_CLASS, CKA_LABEL, CKA_VALUE, CKA_ID = 0x0, 0x3, 0x11, 0x102
CKO_CERTIFICATE, CKO_PRIVATE_KEY = 1, 3
CKM_RSA_PKCS = 0x1
CKR_OK = 0
CKR_ALREADY_INITIALIZED = 0x191
CKR_USER_ALREADY_LOGGED_IN = 0x100
CK_ERRORS = {
    0x32: "The token was removed",
    0xA0: "Wrong PIN (too many wrong PINs lock the token)",
    0xA1: "The PIN has expired: change it with the token maker's tool",
    0xA2: "That PIN is not the right length",
    0xA4: "The token is locked: unlock it with the token maker's tool",
    0xE0: "No token is plugged in",
    0xE1: "The token is not recognised by this driver",
    0x101: "Enter the token PIN",
    0x30: "The token reported a device error: unplug it and plug it in again",
}
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


class _Attr(ctypes.Structure):
    _pack_ = _PACK
    _fields_ = [("type", CK_ULONG), ("pValue", ctypes.c_void_p), ("ulValueLen", CK_ULONG)]


class _Mech(ctypes.Structure):
    _pack_ = _PACK
    _fields_ = [("mechanism", CK_ULONG), ("pParameter", ctypes.c_void_p), ("ulParameterLen", CK_ULONG)]


class TokenError(RuntimeError):
    pass


# positions in CK_FUNCTION_LIST (after the 2-byte version)
_FN = {"C_Initialize": 0, "C_GetSlotList": 4, "C_OpenSession": 12, "C_CloseSession": 13, "C_Login": 18,
       "C_GetAttributeValue": 24, "C_FindObjectsInit": 26, "C_FindObjects": 27, "C_FindObjectsFinal": 28,
       "C_SignInit": 42, "C_Sign": 43}
_P = ctypes.POINTER
_U = CK_ULONG
_SIGS = {
    "C_Initialize": [ctypes.c_void_p],
    "C_GetSlotList": [ctypes.c_ubyte, _P(_U), _P(_U)],
    "C_OpenSession": [_U, _U, ctypes.c_void_p, ctypes.c_void_p, _P(_U)],
    "C_CloseSession": [_U],
    "C_Login": [_U, _U, ctypes.c_char_p, _U],
    "C_GetAttributeValue": [_U, _U, _P(_Attr), _U],
    "C_FindObjectsInit": [_U, _P(_Attr), _U],
    "C_FindObjects": [_U, _P(_U), _U, _P(_U)],
    "C_FindObjectsFinal": [_U],
    "C_SignInit": [_U, _P(_Mech), _U],
    "C_Sign": [_U, ctypes.c_char_p, _U, ctypes.c_char_p, _P(_U)],
}
_libs: dict = {}


class P11:
    """The few PKCS#11 calls the signer needs, on one driver (loaded and initialised once)."""

    def __init__(self, path: str):
        if path in _libs:
            self.fn = _libs[path]
            return
        dll = ctypes.WinDLL(path) if _WIN else ctypes.CDLL(path)  # x64: one calling convention
        get_list = dll.C_GetFunctionList
        get_list.argtypes = [_P(ctypes.c_void_p)]
        get_list.restype = _U
        plist = ctypes.c_void_p()
        self._ok(get_list(ctypes.byref(plist)), "C_GetFunctionList")
        ptr = ctypes.sizeof(ctypes.c_void_p)
        first = 2 if _WIN else ptr  # the 2-byte version, then pointers (packed on Windows)
        fns = {}
        for name, i in _FN.items():
            addr = ctypes.c_void_p.from_address(plist.value + first + i * ptr).value
            fns[name] = ctypes.CFUNCTYPE(_U, *_SIGS[name])(addr)
        rv = fns["C_Initialize"](None)
        if rv not in (CKR_OK, CKR_ALREADY_INITIALIZED):
            self._ok(rv, "C_Initialize")
        _libs[path] = fns
        self.fn = fns

    @staticmethod
    def _ok(rv: int, what: str) -> None:
        if rv != CKR_OK:
            raise TokenError(CK_ERRORS.get(rv, f"The token said {what} failed (0x{rv:x})"))

    def call(self, name: str, *args) -> None:
        self._ok(self.fn[name](*args), name)

    def slots(self) -> list[int]:
        n = _U(0)
        self.call("C_GetSlotList", 1, None, ctypes.byref(n))
        if not n.value:
            raise TokenError("No token is plugged in")
        arr = (_U * n.value)()
        self.call("C_GetSlotList", 1, arr, ctypes.byref(n))
        return list(arr[: n.value])

    def open(self, slot: int, pin: str | None) -> int:
        h = _U(0)
        self.call("C_OpenSession", slot, CKF_SERIAL_SESSION, None, None, ctypes.byref(h))
        if pin:
            raw = pin.encode()
            rv = self.fn["C_Login"](h, CKU_USER, raw, len(raw))
            if rv not in (CKR_OK, CKR_USER_ALREADY_LOGGED_IN):
                self.fn["C_CloseSession"](h)
                self._ok(rv, "C_Login")
        return h.value

    def close(self, h: int) -> None:
        self.fn["C_CloseSession"](h)

    def find(self, h: int, cls: int, obj_id: bytes | None = None) -> list[int]:
        vals = [CK_ULONG(cls)]
        attrs = [_Attr(CKA_CLASS, ctypes.addressof(vals[0]), ctypes.sizeof(CK_ULONG))]
        if obj_id is not None:
            buf = ctypes.create_string_buffer(obj_id, len(obj_id))
            vals.append(buf)
            attrs.append(_Attr(CKA_ID, ctypes.addressof(buf), len(obj_id)))
        tmpl = (_Attr * len(attrs))(*attrs)
        self.call("C_FindObjectsInit", h, tmpl, len(attrs))
        out = []
        try:
            batch = (_U * 16)()
            n = _U(0)
            while True:
                self.call("C_FindObjects", h, batch, 16, ctypes.byref(n))
                if not n.value:
                    break
                out += list(batch[: n.value])
        finally:
            self.fn["C_FindObjectsFinal"](h)
        return out

    def attr(self, h: int, obj: int, kind: int) -> bytes:
        a = (_Attr * 1)(_Attr(kind, None, 0))
        rv = self.fn["C_GetAttributeValue"](h, obj, a, 1)
        if rv != CKR_OK or a[0].ulValueLen in (0, CK_ULONG(-1).value):
            return b""
        buf = ctypes.create_string_buffer(a[0].ulValueLen)
        a[0].pValue = ctypes.addressof(buf)
        self.call("C_GetAttributeValue", h, obj, a, 1)
        return buf.raw[: a[0].ulValueLen]

    def sign_rsa(self, h: int, key: int, data: bytes) -> bytes:
        mech = _Mech(CKM_RSA_PKCS, None, 0)
        self.call("C_SignInit", h, ctypes.byref(mech), key)
        n = _U(0)
        self.call("C_Sign", h, data, len(data), None, ctypes.byref(n))
        out = ctypes.create_string_buffer(n.value)
        self.call("C_Sign", h, data, len(data), out, ctypes.byref(n))
        return out.raw[: n.value]


def pem_of(der: bytes) -> str:
    b = base64.b64encode(der).decode()
    return "-----BEGIN CERTIFICATE-----\n" + "\n".join(b[i:i + 64] for i in range(0, len(b), 64)) + "\n-----END CERTIFICATE-----\n"


def _certs_in(p: P11, h: int):
    for obj in p.find(h, CKO_CERTIFICATE):
        der = p.attr(h, obj, CKA_VALUE)
        if der:
            yield {"id": p.attr(h, obj, CKA_ID), "label": p.attr(h, obj, CKA_LABEL).decode("utf-8", "replace"), "der": der}


def _sessions(p: P11):
    """An open (not logged-in) session on each slot that has a usable token; empty or odd slots are skipped."""
    found = False
    last: TokenError | None = None
    for slot in p.slots():
        try:
            h = p.open(slot, None)
        except TokenError as e:  # e.g. an uninitialised slot, or a reader with nothing in it
            last = e
            continue
        found = True
        yield slot, h
    if not found:
        raise last or TokenError("No token is plugged in")


def _login(p: P11, h: int, pin: str) -> None:
    raw = pin.encode()
    rv = p.fn["C_Login"](h, CKU_USER, raw, len(raw))
    if rv not in (CKR_OK, CKR_USER_ALREADY_LOGGED_IN):
        p._ok(rv, "C_Login")


def token_certs(lib: str, pin: str | None):
    """The certificates on the plugged-in token(s); the PIN is used only if a token shows none without it."""
    p = P11(lib)
    out = []
    for _slot, h in _sessions(p):
        try:
            certs = list(_certs_in(p, h))
            if not certs and pin:
                _login(p, h, pin)
                certs = list(_certs_in(p, h))
            for c in certs:
                out.append({"id": c["id"].hex(), "label": c["label"] or "Certificate", "thumbprint": hashlib.sha1(c["der"]).hexdigest(), "pem": pem_of(c["der"])})
        finally:
            p.close(h)
    return out


def sign_digest(lib: str, pin: str, payload: dict) -> bytes:
    """Signs the ticket's SHA-256 digest (as a PKCS#1 DigestInfo) with the key of the ticket's certificate."""
    p = P11(lib)
    digest_info = SHA256_DIGEST_INFO + bytes.fromhex(payload["d"])
    for _slot, h in _sessions(p):
        try:
            certs = list(_certs_in(p, h))
            logged_in = False
            if not any(hashlib.sha1(c["der"]).hexdigest() == payload["c"] for c in certs):
                # some tokens show their certificates only after the PIN
                _login(p, h, pin)
                logged_in = True
                certs = list(_certs_in(p, h))
            cert = next((c for c in certs if hashlib.sha1(c["der"]).hexdigest() == payload["c"]), None)
            if not cert:
                continue
            if not logged_in:
                _login(p, h, pin)
            keys = p.find(h, CKO_PRIVATE_KEY, cert["id"]) if cert["id"] else []
            if not keys:
                keys = p.find(h, CKO_PRIVATE_KEY)
                if len(keys) != 1:
                    raise TokenError("Could not tell which key on the token belongs to the certificate")
            return p.sign_rsa(h, keys[0], digest_info)
        finally:
            p.close(h)
    raise PermissionError("The certificate Synapse asked for is not on the plugged-in token")


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
                payload = check_ticket(cfg, body["ticket"])
                if not body.get("pin"):
                    return self._send(400, {"error": "Enter the token PIN"})
                with lock:
                    sig = sign_digest(self._lib(cfg), body["pin"], payload)
                return self._send(200, {"signature": base64.b64encode(sig).decode()})
            self._send(404, {"error": "not found"})
        except PermissionError as e:
            self._send(403, {"error": str(e)})
        except LookupError as e:
            self._send(503, {"error": str(e)})
        except TokenError as e:
            self._send(409, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

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
