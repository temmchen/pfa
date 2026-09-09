#!/bin/sh
# Lokaler Testlauf: docs/ (ohne Vault-Inhalt) in einen Arbeitsordner spiegeln, Testdaten
# erzeugen und den Mock-Server starten. Danach im Browser oeffnen:
#   http://localhost:8765/?api=http://localhost:8765     (Schreib-Token im Mock: test-token-rw)
# Der Arbeitsordner liegt bewusst ausserhalb von ~/Documents (Sandbox-Prozesse duerfen dort nicht lesen).
set -e
HIER=$(cd "$(dirname "$0")/.." && pwd)
RUN=${PFA_RUN_DIR:-${TMPDIR:-/tmp}/pfa_run}
mkdir -p "$RUN/docs/vault/pdf"
rsync -a --delete --exclude vault "$HIER/docs/" "$RUN/docs/"
python3 "$HIER/test/make_fixtures.py" "$RUN" >/dev/null
exec python3 "$HIER/test/mock_github.py" --docs "$RUN/docs" --port "${PFA_PORT:-8765}"
