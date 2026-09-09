#!/bin/sh
# Testlauf: docs/ in einen Arbeitsordner kopieren (ohne Vault-Inhalt) und den Mock-Server starten.
# Der Arbeitsordner liegt ausserhalb von ~/Documents, weil der Sandbox-Server dort nicht lesen darf.
set -e
HIER=$(cd "$(dirname "$0")/.." && pwd)
RUN=${PFA_RUN_DIR:-/private/tmp/claude-501/-Users-tbr-Documents/8dd202c9-0480-463e-a33d-f80812362b8a/scratchpad/pfa_run}
mkdir -p "$RUN/docs/vault/pdf"
rsync -a --delete --exclude vault "$HIER/docs/" "$RUN/docs/"
exec python3 "$HIER/test/mock_github.py" --docs "$RUN/docs" --port "${PFA_PORT:-8765}"
