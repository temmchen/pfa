#!/usr/bin/env python3
"""
PFA einrichten oder neu anfangen -- ohne GitHub-Token, ohne Terminal-Gefummel.

Fragt die neue Passphrase ueber den macOS-Standarddialog ab (verdeckt), legt
Schluesselbund und leere Vaults an (wahlweise mit Startdaten), zeigt den
Wiederherstellungsschluessel, und laedt alles zu GitHub hoch.

Aufruf (im Repository-Ordner):
    python3 tools/pfa_einrichten.py [--honorare datei.json] [--finanzen datei.json] [--kein-push]

Honorar-Startdaten: JSON wie beim frueheren Honorar-Dashboard; das Feld "pdfFile"
je Rechnung (lokaler Pfad) legt das PDF verschluesselt mit in den Vault.
Finanz-Startdaten: Klartext-JSON-Export des Finanz-Dashboards ({"eintraege":[...]}).

Die Passphrase bleibt im Speicher dieses einen Prozesses. Fuer Tests kann sie
ueber PFA_PASSPHRASE vorgegeben werden; --ja ueberspringt dann die Rueckfragen.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
REPO = HIER.parent
TITEL = "PFA – Personal Finance Assistant"
SEITE = "https://temmchen.github.io/pfa/"
MIN_PASS = 12

sys.path.insert(0, str(HIER))


# ---------------------------------------------------------------- Dialoge

def _ass(text: str) -> str:
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _osascript(skript: str) -> subprocess.CompletedProcess:
    return subprocess.run(["osascript", "-e", skript], capture_output=True, text=True)


def frage_text(text: str, verdeckt: bool = False) -> str:
    skript = f"display dialog {_ass(text)} default answer \"\" with title {_ass(TITEL)}"
    if verdeckt:
        skript += " with hidden answer"
    p = _osascript(skript)
    if p.returncode != 0:
        sys.exit("Abgebrochen.")
    m = re.search(r"text returned:(.*?)(?:, button returned:.*)?$", p.stdout.strip(), re.S)
    return m.group(1) if m else ""


def frage_weiter(text: str, weiter: str = "Weiter", ernst: bool = False) -> bool:
    art = " with icon caution" if ernst else ""
    p = _osascript(f"display dialog {_ass(text)} with title {_ass(TITEL)} "
                   f"buttons {{\"Abbrechen\", {_ass(weiter)}}} default button {_ass(weiter)}{art}")
    return p.returncode == 0


def melde(text: str, fehler: bool = False) -> None:
    art = " with icon stop" if fehler else ""
    _osascript(f"display dialog {_ass(text)} with title {_ass(TITEL)} buttons {{\"OK\"}} default button \"OK\"{art}")


def schluessel_zeigen(rk: str) -> None:
    """Zeigt den Wiederherstellungsschluessel, legt ihn in die Zwischenablage, sichert ihn auf Wunsch als Datei."""
    _osascript(f"set the clipboard to {_ass(rk)}")
    while True:
        p = _osascript(
            f"display dialog {_ass('Dein Wiederherstellungsschlüssel (liegt jetzt auch in der Zwischenablage):' + chr(10) + chr(10) + rk + chr(10) + chr(10) + 'Er ist der einzige Weg zurück, falls du die Passphrase vergisst, und wird NUR JETZT angezeigt. Bitte in die Passwörter-App legen oder als Datei sichern.')} "
            f"with title {_ass(TITEL)} buttons {{\"Als Datei sichern\", \"Ich habe ihn gesichert\"}} "
            f"default button \"Als Datei sichern\"")
        if "Als Datei sichern" in p.stdout:
            q = _osascript(f"POSIX path of (choose file name with prompt \"Wiederherstellungsschlüssel speichern\" "
                           f"default name \"PFA-Wiederherstellungsschluessel.txt\")")
            if q.returncode == 0 and q.stdout.strip():
                Path(q.stdout.strip()).write_text(
                    "Wiederherstellungsschlüssel für PFA – Personal Finance Assistant\n"
                    f"{rk}\n\nDamit lässt sich eine neue Passphrase setzen, ohne Daten zu verlieren.\n"
                    "Bitte getrennt von der Passphrase aufbewahren.\n", encoding="utf-8")
                melde("Gespeichert.")
            continue
        return


# ---------------------------------------------------------------- Ablauf

def git(*argumente: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *argumente], cwd=REPO, capture_output=True, text=True)


def neue_passphrase(ohne_dialog: bool) -> str:
    env = os.environ.get("PFA_PASSPHRASE")
    if env:
        if len(env) < MIN_PASS:
            sys.exit(f"Die Passphrase muss mindestens {MIN_PASS} Zeichen haben.")
        return env
    if ohne_dialog:
        sys.exit("--ja ohne PFA_PASSPHRASE: keine Passphrase vorhanden.")
    while True:
        p1 = frage_text(f"Neue Passphrase für PFA (mindestens {MIN_PASS} Zeichen).\n\n"
                        "Sie schützt Finanzen und Honorare gleichermaßen und wird nirgends gespeichert – "
                        "am besten gleich in der Passwörter-App ablegen.", verdeckt=True)
        if len(p1) < MIN_PASS:
            melde(f"Zu kurz: mindestens {MIN_PASS} Zeichen.", fehler=True)
            continue
        if p1 != frage_text("Passphrase wiederholen.", verdeckt=True):
            melde("Die beiden Eingaben stimmen nicht überein – bitte noch einmal.", fehler=True)
            continue
        return p1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--honorare", help="Startdaten Honorare (JSON, pdfFile je Rechnung erlaubt)")
    parser.add_argument("--finanzen", help="Startdaten Finanzen (Klartext-JSON)")
    parser.add_argument("--kein-push", action="store_true", help="nur lokal anlegen, nicht hochladen")
    parser.add_argument("--ja", action="store_true", help="keine Rückfragen (nur mit PFA_PASSPHRASE, für Tests)")
    args = parser.parse_args()

    try:
        import pfa_vault as pv
    except SystemExit as e:
        melde(f"{e}\n\nBitte einmalig im Terminal:\npip3 install cryptography", fehler=True)
        sys.exit(1)

    daten = {}
    for schluessel, pfad in (("honorare", args.honorare), ("finanzen", args.finanzen)):
        if not pfad:
            continue
        p = Path(pfad).expanduser()
        if not p.exists():
            melde(f"Startdaten nicht gefunden:\n{p}", fehler=True)
            sys.exit(1)
        try:
            daten[schluessel] = json.loads(p.read_text(encoding="utf-8"))
        except ValueError as e:
            melde(f"Die Datei {p.name} ist kein gültiges JSON:\n\n{e}", fehler=True)
            sys.exit(1)

    if not args.kein_push:
        holen = git("pull", "--ff-only", "--quiet")
        if holen.returncode and "no tracking information" not in holen.stderr and "Repository not found" not in holen.stderr:
            melde("Das Repository ließ sich nicht auf den neuesten Stand bringen:\n\n"
                  f"{holen.stderr.strip() or holen.stdout.strip()}\n\nBitte zuerst „git pull“ ausführen.", fehler=True)
            sys.exit(1)

    vorhanden = pv.KEYRING.exists()
    alte_pdfs = sorted(pv.PDF_DIR.glob("*.enc")) if pv.PDF_DIR.exists() else []
    if not args.ja:
        if vorhanden:
            text = ("Neu anfangen\n\nEs gibt bereits einen PFA-Vault. Ohne die alte Passphrase lassen sich dessen "
                    "Daten NICHT wiederherstellen. Gelöscht und ersetzt werden:\n"
                    "• Schlüsselbund, Finanzen und Honorare\n"
                    + (f"• {len(alte_pdfs)} verschlüsselte Rechnungs-PDF(s)\n" if alte_pdfs else ""))
        else:
            text = "Erste Einrichtung\n\nEs wird ein neuer Schlüsselbund mit leeren Vaults für Finanzen und Honorare angelegt.\n"
        start = []
        if "honorare" in daten:
            start.append(f"{len(daten['honorare'].get('invoices', []))} Rechnung(en) aus {Path(args.honorare).name}")
        if "finanzen" in daten:
            d = daten["finanzen"]
            n = len(d) if isinstance(d, list) else len(d.get("eintraege", []))
            start.append(f"{n} Buchung(en) aus {Path(args.finanzen).name}")
        text += "\nStartdaten: " + (", ".join(start) if start else "keine (leer)") + "\n"
        text += "\nDanach wird alles zu GitHub hochgeladen; die Webseite akzeptiert die neue Passphrase nach 1–2 Minuten."
        if not frage_weiter(text, weiter="Neu anlegen" if vorhanden else "Einrichten", ernst=vorhanden):
            sys.exit("Abgebrochen.")

    passphrase = neue_passphrase(args.ja)
    try:
        rk = pv.vault_anlegen(passphrase, daten.get("honorare"), daten.get("finanzen"))
        dek = pv.huelle_oeffnen(pv.keyring_laden()["huellen"]["pw"], passphrase)   # Kontrolle
        hon = pv.daten_lesen(dek, "honorar")
        fin = pv.daten_lesen(dek, "finanz")
    except Exception as e:                       # noqa: BLE001 - Dialog statt Traceback
        melde(f"Der Vault konnte nicht angelegt werden:\n\n{e}", fehler=True)
        sys.exit(1)

    zusammenfassung = (f"Vault angelegt: {len(hon['invoices'])} Rechnung(en), {len(fin['eintraege'])} Buchung(en)"
                       + (f"; {len(alte_pdfs)} alte PDF-Datei(en) entfernt" if alte_pdfs else "") + ".")
    if args.ja:
        print(zusammenfassung)
        print(f"Wiederherstellungsschlüssel: {rk}")
    else:
        schluessel_zeigen(rk)

    if args.kein_push:
        if not args.ja:
            melde(f"{zusammenfassung}\n\nNur lokal – zum Veröffentlichen fehlt noch:\ngit add docs/vault && git commit && git push")
        return

    git("add", "-A", "docs/vault")
    if not git("diff", "--cached", "--quiet").returncode:
        melde(f"{zusammenfassung}\n\nAm Repository hat sich nichts geändert – nichts hochzuladen.")
        return
    r = git("commit", "-m", "PFA: Vault neu angelegt")
    if r.returncode:
        melde(f"Commit fehlgeschlagen:\n\n{r.stderr.strip()}", fehler=True)
        sys.exit(1)
    r = git("push")
    if r.returncode:
        melde("Der Vault ist lokal angelegt, das Hochladen zu GitHub ist aber fehlgeschlagen:\n\n"
              f"{r.stderr.strip()}\n\nNachholen mit: git push", fehler=True)
        sys.exit(1)
    melde(f"{zusammenfassung}\n\nHochgeladen. In 1–2 Minuten lässt sich PFA mit der neuen Passphrase entsperren:\n{SEITE}\n\n"
          "Zum Bearbeiten auf der Seite braucht es ein GitHub-Token mit „Contents: Read and write“ für temmchen/pfa "
          "(einmalig unter „Verwaltung“ eintragen, es wird verschlüsselt gemerkt).")
    print(zusammenfassung + " Hochgeladen.")


if __name__ == "__main__":
    main()
