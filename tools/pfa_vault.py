#!/usr/bin/env python3
"""
PFA – Vault-Werkzeug (Kommandozeile), Gegenstueck zu docs/crypto.js + core.js.

Schluesselbund docs/vault/keyring.json:
    {"format":"pfa-keyring","version":1,"huellen":{"pw":{salt,iv,paket,runden},
     "wk":{...}}}   -- Datenschluessel (DEK, 32 Byte) zweimal verpackt:
    mit der Passphrase und mit dem Wiederherstellungsschluessel (PBKDF2-SHA-256,
    600 000 Runden, AES-256-GCM).
Vault-Dateien (PFA1): "PFA1" + IV(12) + AES-256-GCM-Ciphertext (Schluessel = DEK):
    docs/vault/finanz.enc, docs/vault/honorar.enc, docs/vault/pdf/<id>.enc

Befehle:
    init [--force] [--honorare JSON] [--finanzen JSON]   neuen Vault anlegen
    list                                                 Inhalt anzeigen
    export {finanz,honorar} [-o DATEI]                   Klartext-JSON
    import-honorar JSON  (Feld "pdfFile" je Rechnung = lokales PDF -> Vault)
    import-finanz JSON
    passphrase                                           Passphrase wechseln (nur Schluesselbund)
    recovery-neu                                         neuen Wiederherstellungsschluessel
    pdf-get NUMMER [-o DATEI]                            PDF entschluesseln

Passphrase: Umgebungsvariable PFA_PASSPHRASE oder Abfrage (verdeckt).
Voraussetzung: pip3 install cryptography
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import secrets
import sys
import uuid
from datetime import datetime, timezone
from hashlib import pbkdf2_hmac
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
except ImportError:  # pragma: no cover
    sys.exit("Bitte zuerst installieren:  pip3 install cryptography")

RUNDEN = 600_000
MAGIC = b"PFA1"
IV_LEN = 12
RK_ZEICHEN = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
MIN_PASS = 12

REPO_ROOT = Path(__file__).resolve().parent.parent
VAULT_DIR = Path(os.environ.get("PFA_VAULT_DIR") or REPO_ROOT / "docs" / "vault")
KEYRING = VAULT_DIR / "keyring.json"
PDF_DIR = VAULT_DIR / "pdf"
MODULE = ("finanz", "honorar")

FINANZ_LEER = {"version": 1, "titel": "Bilanzierung — Einnahmen & Ausgaben",
               "waehrung": "EUR", "startkapital": 0, "eintraege": []}
HONORAR_LEER = {"version": 1, "debtors": ["LaLux"], "invoices": []}


class VaultError(Exception):
    pass


# ---------------------------------------------------------------- Krypto

b64 = lambda b: base64.b64encode(b).decode("ascii")          # noqa: E731
vonb64 = lambda s: base64.b64decode(s)                        # noqa: E731


def ableiten(geheim: str, salt: bytes, runden: int) -> bytes:
    return pbkdf2_hmac("sha256", geheim.encode("utf-8"), salt, runden, dklen=32)


def huelle_bauen(dek: bytes, geheim: str, runden: int = RUNDEN) -> dict:
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(IV_LEN)
    kek = ableiten(geheim, salt, runden)
    return {"salt": b64(salt), "iv": b64(iv),
            "paket": b64(AESGCM(kek).encrypt(iv, dek, None)), "runden": runden}


def huelle_oeffnen(h: dict, geheim: str) -> bytes:
    kek = ableiten(geheim, vonb64(h["salt"]), int(h.get("runden") or RUNDEN))
    try:
        return AESGCM(kek).decrypt(vonb64(h["iv"]), vonb64(h["paket"]), None)
    except InvalidTag:
        raise VaultError("Geheimnis passt nicht.")


def neuer_wk() -> str:
    b = secrets.token_bytes(24)
    s = "".join(RK_ZEICHEN[x % 32] for x in b)
    return "-".join(s[i:i + 4] for i in range(0, 24, 4))


def rk_norm(s: str) -> str:
    s = "".join(c for c in (s or "").upper() if c.isalnum())
    return s.replace("I", "1").replace("L", "1").replace("O", "0").replace("U", "V")


def verschluesseln(dek: bytes, plain: bytes) -> bytes:
    iv = secrets.token_bytes(IV_LEN)
    return MAGIC + iv + AESGCM(dek).encrypt(iv, plain, None)


def entschluesseln(dek: bytes, blob: bytes) -> bytes:
    if blob[:4] != MAGIC:
        raise VaultError("Kein PFA1-Format.")
    try:
        return AESGCM(dek).decrypt(blob[4:4 + IV_LEN], blob[4 + IV_LEN:], None)
    except InvalidTag:
        raise VaultError("Entschlüsselung fehlgeschlagen – Schlüssel falsch oder Datei beschädigt.")


# ---------------------------------------------------------------- Schluesselbund / Dateien

def jetzt() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def keyring_laden() -> dict | None:
    if not KEYRING.exists():
        return None
    kr = json.loads(KEYRING.read_text(encoding="utf-8"))
    if kr.get("format") != "pfa-keyring" or "pw" not in kr.get("huellen", {}):
        raise VaultError("Schlüsselbund unlesbar.")
    return kr


def keyring_schreiben(kr: dict) -> None:
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    KEYRING.write_text(json.dumps(kr, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def get_passphrase(confirm: bool = False, prompt: str = "Passphrase: ") -> str:
    env = os.environ.get("PFA_PASSPHRASE")
    if env:
        if confirm and len(env) < MIN_PASS:
            sys.exit(f"Die Passphrase muss mindestens {MIN_PASS} Zeichen haben.")
        return env
    p1 = getpass.getpass(prompt)
    if confirm:
        if len(p1) < MIN_PASS:
            sys.exit(f"Die Passphrase muss mindestens {MIN_PASS} Zeichen haben – die Dateien "
                     "sind öffentlich abrufbar, die Passphrase ist der einzige Schutz.")
        if p1 != getpass.getpass("Passphrase wiederholen: "):
            sys.exit("Passphrasen stimmen nicht überein.")
    return p1


def dek_holen(passphrase: str | None = None) -> bytes:
    kr = keyring_laden()
    if not kr:
        raise VaultError(f"{KEYRING} existiert nicht – zuerst 'init' ausführen.")
    return huelle_oeffnen(kr["huellen"]["pw"], passphrase or get_passphrase())


def daten_lesen(dek: bytes, name: str) -> dict | None:
    f = VAULT_DIR / f"{name}.enc"
    if not f.exists():
        return None
    return json.loads(entschluesseln(dek, f.read_bytes()).decode("utf-8"))


def daten_schreiben(dek: bytes, name: str, obj: dict) -> None:
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    (VAULT_DIR / f"{name}.enc").write_bytes(
        verschluesseln(dek, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")))


def pdf_anhaengen(dek: bytes, inv: dict, pdf_path: str) -> None:
    pdf = Path(pdf_path).expanduser()
    if not pdf.exists():
        raise VaultError(f"PDF nicht gefunden: {pdf}")
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{inv['id']}.enc"
    (PDF_DIR / name).write_bytes(verschluesseln(dek, pdf.read_bytes()))
    inv["pdf"] = {"type": "vault", "file": name}


def honorar_normalisieren(dek: bytes, data: dict) -> tuple[dict, int]:
    data.setdefault("version", 1)
    data.setdefault("debtors", ["LaLux"])
    data.setdefault("invoices", [])
    angehaengt = 0
    for inv in data["invoices"]:
        inv.setdefault("id", str(uuid.uuid4()))
        inv.setdefault("mahnungen", {})
        pdf_path = inv.pop("pdfFile", None)
        if pdf_path:
            pdf_anhaengen(dek, inv, pdf_path)
            angehaengt += 1
    return data, angehaengt


def finanz_normalisieren(data) -> dict:
    if isinstance(data, list):
        data = {"eintraege": data}
    out = dict(FINANZ_LEER)
    out.update({k: v for k, v in data.items() if k in ("titel", "waehrung", "startkapital")})
    out["eintraege"] = []
    for e in data.get("eintraege", []):
        if not isinstance(e, dict):
            continue
        try:
            betrag = abs(float(e.get("betrag", 0)))
        except (TypeError, ValueError):
            continue
        out["eintraege"].append({
            "id": str(e.get("id") or uuid.uuid4().hex[:14]),
            "typ": "credit" if e.get("typ") == "credit" else "debit",
            "label": str(e.get("label") or "(ohne Bezeichnung)").strip(),
            "betrag": round(betrag, 2),
            "datum": str(e.get("datum") or datetime.now().date().isoformat())[:10],
            "kategorie": str(e.get("kategorie") or "").strip(),
            "notiz": str(e.get("notiz") or "").strip(),
            "fix": bool(e.get("fix")),
        })
    return out


# ---------------------------------------------------------------- Kernoperationen (auch fuer pfa_einrichten.py)

def vault_anlegen(passphrase: str, honorare: dict | None = None, finanzen: dict | None = None) -> str:
    """Legt Schluesselbund + beide Vaults neu an (alte PDFs werden entfernt). Gibt den Wiederherstellungsschluessel zurueck."""
    dek = secrets.token_bytes(32)
    rk = neuer_wk()
    kr = {"format": "pfa-keyring", "version": 1, "erstellt": jetzt(), "geaendert": None,
          "huellen": {"pw": huelle_bauen(dek, passphrase), "wk": huelle_bauen(dek, rk_norm(rk))}}
    if PDF_DIR.exists():
        for alt in PDF_DIR.glob("*.enc"):
            alt.unlink()
    keyring_schreiben(kr)
    daten_schreiben(dek, "finanz", finanz_normalisieren(finanzen) if finanzen else dict(FINANZ_LEER))
    hon = dict(HONORAR_LEER)
    if honorare:
        hon, _ = honorar_normalisieren(dek, honorare)
    daten_schreiben(dek, "honorar", hon)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    return rk


# ---------------------------------------------------------------- Befehle

def cmd_init(args):
    if KEYRING.exists() and not args.force:
        sys.exit(f"{KEYRING} existiert bereits (mit --force alles neu anlegen – alte Daten sind dann weg).")
    honorare = json.loads(Path(args.honorare).read_text(encoding="utf-8")) if args.honorare else None
    finanzen = json.loads(Path(args.finanzen).read_text(encoding="utf-8")) if args.finanzen else None
    passphrase = get_passphrase(confirm=True, prompt="Neue Passphrase: ")
    rk = vault_anlegen(passphrase, honorare, finanzen)
    print(f"Vault angelegt: {VAULT_DIR}")
    print("\nWiederherstellungsschlüssel (NUR JETZT sichtbar – bitte sicher aufbewahren):\n")
    print(f"    {rk}\n")


def cmd_list(args):
    dek = dek_holen()
    fin = daten_lesen(dek, "finanz") or FINANZ_LEER
    hon = daten_lesen(dek, "honorar") or HONORAR_LEER
    print(f"Finanzen: {len(fin['eintraege'])} Buchungen · Titel „{fin.get('titel')}“")
    for e in fin["eintraege"][:20]:
        vz = "+" if e["typ"] == "credit" else "-"
        print(f"  {e['datum']}  {vz}{e['betrag']:>10.2f}  {e['label']}  [{e.get('kategorie','')}]")
    if len(fin["eintraege"]) > 20:
        print(f"  … und {len(fin['eintraege']) - 20} weitere")
    print(f"\nHonorare: {len(hon['invoices'])} Rechnungen · Debitoren: {', '.join(hon['debtors'])}")
    for inv in hon["invoices"]:
        pdf = "PDF" if inv.get("pdf", {}).get("type") == "vault" else ("Link" if inv.get("pdf") else "-")
        print(f"  {inv.get('number'):<18} {float(inv.get('amount') or 0):>10.2f} €  {inv.get('status'):<11} {pdf:<4} {inv.get('name','')}")


def cmd_export(args):
    dek = dek_holen()
    obj = daten_lesen(dek, args.modul) or (FINANZ_LEER if args.modul == "finanz" else HONORAR_LEER)
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"Exportiert nach {args.output} (Klartext!)")
    else:
        print(text)


def cmd_import_honorar(args):
    dek = dek_holen()
    data = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
    data, angehaengt = honorar_normalisieren(dek, data)
    if args.merge:
        alt = daten_lesen(dek, "honorar") or dict(HONORAR_LEER)
        bekannt = {str(i.get("number")).strip().lower() for i in alt["invoices"]}
        neu = [i for i in data["invoices"] if str(i.get("number")).strip().lower() not in bekannt]
        alt["invoices"].extend(neu)
        alt["debtors"] = sorted(set(alt["debtors"]) | set(data["debtors"]))
        data = alt
        print(f"{len(neu)} neue Rechnung(en) hinzugefügt")
    daten_schreiben(dek, "honorar", data)
    print(f"{len(data['invoices'])} Rechnungen im Vault, {angehaengt} PDF(s) verschlüsselt abgelegt")


def cmd_import_finanz(args):
    dek = dek_holen()
    data = finanz_normalisieren(json.loads(Path(args.json_file).read_text(encoding="utf-8")))
    if args.merge:
        alt = daten_lesen(dek, "finanz") or dict(FINANZ_LEER)
        bekannt = {(e["typ"], e["label"], e["betrag"], e["datum"]) for e in alt["eintraege"]}
        neu = [e for e in data["eintraege"] if (e["typ"], e["label"], e["betrag"], e["datum"]) not in bekannt]
        alt["eintraege"].extend(neu)
        data = alt
        print(f"{len(neu)} neue Buchung(en) hinzugefügt")
    daten_schreiben(dek, "finanz", data)
    print(f"{len(data['eintraege'])} Buchungen im Vault")


def cmd_passphrase(args):
    kr = keyring_laden()
    if not kr:
        sys.exit("Kein Schlüsselbund vorhanden.")
    dek = huelle_oeffnen(kr["huellen"]["pw"], get_passphrase(prompt="Aktuelle Passphrase: "))
    neu = getpass.getpass("Neue Passphrase: ")
    if len(neu) < MIN_PASS:
        sys.exit(f"Mindestens {MIN_PASS} Zeichen.")
    if neu != getpass.getpass("Neue Passphrase wiederholen: "):
        sys.exit("Passphrasen stimmen nicht überein.")
    kr["huellen"]["pw"] = huelle_bauen(dek, neu)
    kr["geaendert"] = jetzt()
    keyring_schreiben(kr)
    print("Passphrase geändert (nur der Schlüsselbund wurde neu geschrieben).")


def cmd_recovery_neu(args):
    kr = keyring_laden()
    if not kr:
        sys.exit("Kein Schlüsselbund vorhanden.")
    dek = huelle_oeffnen(kr["huellen"]["pw"], get_passphrase())
    rk = neuer_wk()
    kr["huellen"]["wk"] = huelle_bauen(dek, rk_norm(rk))
    kr["geaendert"] = jetzt()
    keyring_schreiben(kr)
    print(f"Neuer Wiederherstellungsschlüssel (der alte gilt nicht mehr):\n\n    {rk}\n")


def cmd_pdf_get(args):
    dek = dek_holen()
    hon = daten_lesen(dek, "honorar") or HONORAR_LEER
    for inv in hon["invoices"]:
        if inv.get("number") == args.number or inv.get("id") == args.number:
            if inv.get("pdf", {}).get("type") != "vault":
                sys.exit("Diese Rechnung hat kein PDF im Vault.")
            out = Path(args.output or f"{args.number}.pdf".replace("/", "_"))
            out.write_bytes(entschluesseln(dek, (PDF_DIR / inv["pdf"]["file"]).read_bytes()))
            print(f"PDF gespeichert: {out}")
            return
    sys.exit(f"Rechnung '{args.number}' nicht gefunden.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init"); p.add_argument("--force", action="store_true")
    p.add_argument("--honorare"); p.add_argument("--finanzen"); p.set_defaults(func=cmd_init)
    p = sub.add_parser("list"); p.set_defaults(func=cmd_list)
    p = sub.add_parser("export"); p.add_argument("modul", choices=MODULE); p.add_argument("-o", "--output"); p.set_defaults(func=cmd_export)
    p = sub.add_parser("import-honorar"); p.add_argument("json_file"); p.add_argument("--merge", action="store_true"); p.set_defaults(func=cmd_import_honorar)
    p = sub.add_parser("import-finanz"); p.add_argument("json_file"); p.add_argument("--merge", action="store_true"); p.set_defaults(func=cmd_import_finanz)
    p = sub.add_parser("passphrase"); p.set_defaults(func=cmd_passphrase)
    p = sub.add_parser("recovery-neu"); p.set_defaults(func=cmd_recovery_neu)
    p = sub.add_parser("pdf-get"); p.add_argument("number"); p.add_argument("-o", "--output"); p.set_defaults(func=cmd_pdf_get)
    args = parser.parse_args()
    try:
        args.func(args)
    except VaultError as e:
        sys.exit(f"Fehler: {e}")


if __name__ == "__main__":
    main()
