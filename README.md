# PFA – Personal Finance Assistant

Eine GitHub-Pages-Webseite, die **zwei Bereiche unter einem Login** vereint:

| Bereich | Inhalt |
|---------|--------|
| 💶 **Finanzen** | Privates Budget: Credit (Einnahmen) / Debit (Ausgaben), Kategorien, Monatsverlauf, Fixposten, Monat kopieren, Import/Export |
| 🧾 **Honorare** | Honorarnoten aus Gutachten: Ampel 🔴 offen / 🟡 verschickt / 🟢 bezahlt, Fälligkeit mit ÜBERFÄLLIG-Markierung, Mahnstufen 1–3, Debitoren, Rechnungs-PDFs im Vault oder als externer Link, Excel-/PDF-Export |

Nach dem Entsperren erscheint ein **Home-Menü** mit einer Kachel je Bereich
(inklusive Kennzahl: Saldo des Monats bzw. offene Honorare). Oben lässt sich
jederzeit zwischen Home, Finanzen und Honoraren wechseln; **„Sichern &
beenden“** schreibt offene Änderungen weg und sperrt die App.

Live: **https://temmchen.github.io/pfa/** · Repository `temmchen/pfa`, Pages aus **`docs/`**.

PFA ersetzt die beiden früheren Einzel-Dashboards (`compta_dashboard` und
`finanz-dashboard`), siehe [Umzug](#umzug-von-den-alten-dashboards).

## Sicherheitskonzept

GitHub Pages ist ein öffentlicher Webserver – deshalb liegt **nichts** im Klartext dort.

- **Ein Datenschlüssel** (AES-256-GCM, zufällig, 256 Bit) verschlüsselt alle
  Dateien im Vault: `docs/vault/finanz.enc`, `docs/vault/honorar.enc` und
  alle Rechnungs-PDFs `docs/vault/pdf/*.enc` (Dateiformat `PFA1`).
- Der Datenschlüssel liegt **zweimal verpackt** im Schlüsselbund
  `docs/vault/keyring.json`: einmal mit der **Passphrase**, einmal mit dem
  **Wiederherstellungsschlüssel** (24 Zeichen, wird bei der Einrichtung genau
  einmal angezeigt). Beide über PBKDF2-SHA-256 mit 600 000 Runden.
- Passphrase und Wiederherstellungsschlüssel werden **nirgends gespeichert**,
  auch keine Prüfsumme. Wer die Seite ohne Passphrase öffnet oder das
  Repository durchsucht, sieht nur unlesbare Dateien.
- **Passphrase vergessen?** Mit dem Wiederherstellungsschlüssel lässt sich eine
  neue Passphrase setzen – **alle Daten bleiben erhalten** (es wird nur der
  Schlüsselbund neu geschrieben). Ohne beides bleibt nur „Neu anfangen“.
- **Automatische Sperre** nach 10 Minuten Inaktivität, Sperren-Knopf für
  sofort, Fehlversuchs-Bremse beim Entsperren.
- Lesen braucht kein Token. **Schreiben** läuft über die GitHub-Contents-API
  mit einem fine-grained Token („Verwaltung“); es kann – mit dem Datenschlüssel
  verschlüsselt – auf dem Gerät gemerkt werden und ist ohne Passphrase wertlos.
- Kein Tracking, keine Server von Dritten, `noindex`.

**Grenzen, ehrlich benannt:** Git vergisst nichts – ältere Datei-Versionen
bleiben in der Historie (verschlüsselt). Alle Pages-Projekte eines Accounts
teilen sich den Ursprung `temmchen.github.io`; PFA legt deshalb nichts
Unverschlüsseltes in den Browser-Speicher. Dem Token eine kurze Laufzeit geben
und bei Verdacht sofort widerrufen.

## Einrichtung

1. **GitHub Pages aktivieren:** Repository → Settings → Pages → Source
   *Deploy from a branch*, Branch `main`, Ordner **/docs** → Save.
   Nach 1–2 Minuten ist https://temmchen.github.io/pfa/ erreichbar.
2. **GitHub-Token** anlegen (nötig für alles, was schreibt):
   Settings → Developer settings → Personal access tokens → **Fine-grained
   tokens** → Generate new token. Repository access: *Only select repositories*
   → `temmchen/pfa`. Permissions → Repository permissions →
   **Contents: Read and write**. Sonst nichts.
3. **Ersteinrichtung** – zwei Wege:
   - **Im Browser:** Beim ersten Aufruf erscheint „PFA einrichten“: Passphrase
     (min. 12 Zeichen) zweimal, GitHub-Token, fertig. Danach wird der
     Wiederherstellungsschlüssel **einmalig** angezeigt – kopieren oder als
     Datei sichern und in der Passwörter-App ablegen.
   - **Ohne Token, per Skript** (fragt die Passphrase im macOS-Dialog ab, legt
     den Schlüsselbund lokal an und pusht):

     ```bash
     python3 tools/pfa_einrichten.py
     ```

     Mit Startdaten: `--honorare datei.json` (Feld `pdfFile` je Rechnung legt
     das PDF mit in den Vault) und/oder `--finanzen datei.json`.
     Voraussetzung einmalig: `pip3 install cryptography`.

Der Branch `main` darf keine Regel wie „Require a pull request“ bekommen – die
Verwaltung schreibt direkt auf `main`.

## Tägliche Nutzung

- **Entsperren** mit der Passphrase → Home-Menü → Bereich wählen.
- **Verwaltung** (oben): Token einmal eintragen, „auf diesem Gerät merken“.
  Danach werden Änderungen in beiden Bereichen automatisch gespeichert; ohne
  Verwaltung ist alles nur Ansicht (gelbe Leiste).
- **Finanzen:** Buchungen links/rechts erfassen (Betrag auch als Rechnung wie
  `45+12,90`), Zeile bearbeiten, duplizieren, als 🔁 Fixposten markieren,
  auf die andere Seite verschieben; Filter nach Zeitraum/Kategorie/Suche;
  „Monat kopieren“ für wiederkehrende Posten; Einstellungen (Untertitel,
  Währung, Startkapital, Beispieldaten).
- **Honorare:** Neue Rechnung mit Nummer, Betrag, Debitor, Status, Terminen und
  PDF (verschlüsselt hochladen oder externer Link); Status direkt an der
  Rechnung umstellen; Mahnstufen 1 → 2 → 3 per Klick (Klick auf die höchste
  Stufe entfernt sie); Ampel-Karten, Debitor- und Jahresfilter; Zurücksetzen
  (alles oder ein Jahr, Tippbestätigung `LÖSCHEN`).
- **Sichern & beenden**: wartet auf ausstehende Speicherungen und sperrt.
- **Passphrase & Zugang** (Verwaltung → 🔑): Passphrase ändern, neuen
  Wiederherstellungsschlüssel erzeugen.

## Sicherungen, Export, Import

- **Verschlüsselte Sicherung** (beide Bereiche, jeweils im Export-Dialog):
  eine `.json`-Datei im Format `pfa-sicherung`. Sie trägt die Hüllen des
  Schlüsselbunds und öffnet sich deshalb **mit der Passphrase oder dem
  Wiederherstellungsschlüssel** auf jedem Gerät – auch nach einem Neuanfang.
  Wahlweise mit **eigener Passphrase** (dann ein frischer Sicherungsschlüssel;
  der Datenschlüssel verlässt den Vault nicht). Honorar-Sicherungen können die
  Rechnungs-PDFs enthalten; beim Import werden sie in den Vault zurückgelegt.
- **Klartext:** JSON und CSV (beide Bereiche), Excel `.xlsx` und PDF-Bericht
  (Honorare). Klartext ist für niemanden sonst bestimmt.
- **Import** versteht PFA-Sicherungen, Klartext-JSON, CSV (auch Bank-Export
  bei Finanzen) sowie die Formate der alten Dashboards (siehe unten).
  Modus „Hinzufügen“ überspringt Duplikate, „Ersetzen“ tauscht den Bestand.

## Passphrase vergessen

Auf dem Sperrbildschirm **„Passphrase vergessen?“**:

- **Mit Wiederherstellungsschlüssel:** neue Passphrase setzen (braucht das
  Token, um den Schlüsselbund zu speichern) – oder „Nur entsperren“ ohne Token
  und die Passphrase später unter Passphrase & Zugang ändern. Daten bleiben.
- **Ohne Schlüssel:** „Alles löschen und neu anfangen“ (Token + neue
  Passphrase + Tippbestätigung `NEU ANFANGEN`) – alter Vault und alle PDFs
  werden gelöscht und durch einen leeren Vault ersetzt; anschließend eine
  Sicherung importieren. Ohne Token: `python3 tools/pfa_einrichten.py`.

## Umzug von den alten Dashboards

- **Finanz-Dashboard** (Buchungen lagen nur im Browser): PFA erkennt den alten
  Bestand im selben Browser automatisch („Jetzt übernehmen“ im Bereich
  Finanzen, altes Passwort eingeben). Alternativ im alten Dashboard *Export →
  Verschlüsselte Sicherung* speichern und in PFA importieren.
- **Honorar-Übersicht:** eine alte verschlüsselte Sicherung (`.enc`) oder ein
  JSON-Export lässt sich im Bereich Honorare importieren; oder die Rechnungen
  gleich bei der Einrichtung mitgeben (`--honorare`).

## Kommandozeilen-Werkzeug

```bash
python3 tools/pfa_vault.py list                       # Inhalt anzeigen
python3 tools/pfa_vault.py import-honorar datei.json   # (--merge zum Hinzufügen; pdfFile je Rechnung)
python3 tools/pfa_vault.py import-finanz datei.json
python3 tools/pfa_vault.py export honorar -o h.json    # Klartext
python3 tools/pfa_vault.py pdf-get 2026-0044349-01     # PDF entschlüsseln
python3 tools/pfa_vault.py passphrase                  # Passphrase wechseln
python3 tools/pfa_vault.py recovery-neu                # neuer Wiederherstellungsschlüssel
```

Danach `git add docs/vault && git commit && git push`. Passphrase über
`PFA_PASSPHRASE` oder Abfrage.

## Aufbau

| Datei | Aufgabe |
|-------|---------|
| `docs/index.html` | Anmeldung, Home, beide Bereiche, alle Dialoge |
| `docs/core.js` | Schlüsselbund, Entsperren, GitHub-API, Modul-Registrierung, Navigation, Sperre |
| `docs/crypto.js` | Hüllen (PBKDF2 + AES-GCM), Dateiformat PFA1, Altformat TBV1 |
| `docs/finanz.js` | Bereich Finanzen |
| `docs/honorar.js`, `docs/honorar-export.js` | Bereich Honorare + Excel/PDF/Sicherung |
| `tools/pfa_vault.py`, `tools/pfa_einrichten.py` | Kommandozeile bzw. Einrichtung per macOS-Dialog |
| `test/mock_github.py` | lokaler Testserver mit nachgebauter GitHub-Contents-API (`?api=http://localhost:8765`) |
