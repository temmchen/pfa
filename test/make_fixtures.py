#!/usr/bin/env python3
"""Testdaten fuer den lokalen Lauf erzeugen: Startdaten, alte Formate (Finanz-Tresor, TBV1), CSV.

    python3 test/make_fixtures.py ARBEITSORDNER      (ARBEITSORDNER/fixtures + ARBEITSORDNER/docs/test-fixtures)
"""
import base64, json, os, secrets, sys
from hashlib import pbkdf2_hmac
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

RUN = os.path.abspath(sys.argv[1])
FX = os.path.join(RUN, "fixtures"); PUB = os.path.join(RUN, "docs", "test-fixtures")
os.makedirs(FX, exist_ok=True); os.makedirs(PUB, exist_ok=True)
b64 = lambda b: base64.b64encode(b).decode()

pdf = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 24 Tf 30 100 Td (PFA Test-Rechnung) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF
"""
open(os.path.join(FX, "test.pdf"), "wb").write(pdf)
hon = {"debtors": ["LaLux", "Foyer"], "invoices": [
    {"number": "T-2026-001", "name": "Honorarnote – Testfall A", "amount": 1211.86, "debtor": "LaLux", "status": "bezahlt",
     "date": "2026-05-12", "dueDate": "2026-06-11", "paidDate": "2026-06-02", "pdfFile": os.path.join(FX, "test.pdf"), "notes": "mit 17 % TVA"},
    {"number": "T-2026-002", "name": "Honorarnote – Testfall B", "amount": 2669.05, "debtor": "LaLux", "status": "verschickt",
     "date": "2026-07-03", "dueDate": "2026-08-02", "mahnungen": {"1": "2026-08-20"}},
    {"number": "T-2026-003", "name": "Honorarnote – Testfall C", "amount": 1766.04, "debtor": "Foyer", "status": "offen",
     "date": "2026-08-15", "dueDate": "2026-09-14"}]}
json.dump(hon, open(os.path.join(FX, "honorare-seed.json"), "w"), ensure_ascii=False, indent=1)
fin = {"titel": "Haushalt Test", "waehrung": "EUR", "startkapital": 2500, "eintraege": [
    {"typ": "credit", "label": "Gehalt", "betrag": 3850, "datum": "2026-08-28", "kategorie": "Gehalt", "fix": True},
    {"typ": "debit", "label": "Miete", "betrag": 1180, "datum": "2026-08-01", "kategorie": "Miete", "fix": True},
    {"typ": "debit", "label": "Strom", "betrag": 145.5, "datum": "2026-08-05", "kategorie": "Nebenkosten", "fix": True},
    {"typ": "debit", "label": "Tanken", "betrag": 72.4, "datum": "2026-09-03", "kategorie": "Auto/Transport"}]}
json.dump(fin, open(os.path.join(FX, "finanzen-seed.json"), "w"), ensure_ascii=False, indent=1)

# Altes Finanz-Dashboard: Tresorformat (PBKDF2 310k, Huellen pw+wk, daten {iv, inhalt})
def huelle(dek, geheim, runden=310000):
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    kek = pbkdf2_hmac("sha256", geheim.encode(), salt, runden, 32)
    return {"salt": b64(salt), "iv": b64(iv), "paket": b64(AESGCM(kek).encrypt(iv, dek, None)), "runden": runden}
dek = secrets.token_bytes(32); iv = secrets.token_bytes(12)
daten = {"titel": "Altes Finanz-Dashboard", "waehrung": "EUR", "startkapital": 100, "eintraege": [
    {"id": "alt1", "typ": "credit", "label": "Alt-Gehalt", "betrag": 3000, "datum": "2026-06-28", "kategorie": "Gehalt", "notiz": "", "fix": True},
    {"id": "alt2", "typ": "debit", "label": "Alt-Miete", "betrag": 1100, "datum": "2026-06-01", "kategorie": "Miete", "notiz": "aus dem alten Dashboard", "fix": True}]}
tresor = {"format": "finanz-dashboard-tresor", "version": 1, "erstellt": "2026-09-08T03:00:00Z", "geaendert": "2026-09-08T03:00:00Z",
          "huellen": {"pw": huelle(dek, "alt-passwort"), "wk": huelle(dek, "ABCDEFGHJKMNPQRSTVWXYZ01")},
          "daten": {"iv": b64(iv), "inhalt": b64(AESGCM(dek).encrypt(iv, json.dumps(daten).encode(), None))}}
json.dump(tresor, open(os.path.join(PUB, "alt-finanz.json"), "w"))

# Alte Honorar-Sicherung: TBV1 (Magic, Salt16, Iterationen, IV12, AES-GCM mit Passphrase)
def tbv1(passphrase, plain, iterations=600000):
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = pbkdf2_hmac("sha256", passphrase.encode(), salt, iterations, 32)
    return b"TBV1" + salt + iterations.to_bytes(4, "big") + iv + AESGCM(key).encrypt(iv, plain, None)
paket = {"format": "honorar-sicherung", "version": 1, "debtors": ["LaLux"], "invoices": [
    {"id": "alt-hn-1", "number": "HN-ALT-001", "name": "Alte Honorarnote (TBV1-Sicherung)", "amount": 999.99, "debtor": "LaLux",
     "status": "offen", "date": "2026-03-01", "dueDate": "2026-03-31", "mahnungen": {}, "pdf": {"type": "vault", "file": "alt-hn-1.enc"}}],
    "pdfs": {"alt-hn-1": b64(pdf)}}
open(os.path.join(PUB, "alt-honorar.enc"), "wb").write(tbv1("alte-honorar-passphrase", json.dumps(paket).encode()))
open(os.path.join(PUB, "buchungen.csv"), "w").write("typ;label;betrag;datum;kategorie;notiz\ncredit;CSV-Zins;12,34;01.09.2026;Zinsen;aus CSV\ndebit;CSV-Kino;24,00;02.09.2026;Freizeit;\n")
print("fixtures:", sorted(os.listdir(FX)), sorted(os.listdir(PUB)))
