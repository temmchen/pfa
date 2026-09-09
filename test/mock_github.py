#!/usr/bin/env python3
"""
Lokaler Testserver: liefert docs/ aus und spielt die GitHub-Contents-API nach.

    python3 test/mock_github.py --docs PFAD [--port 8765]

Die App laeuft dann unter http://localhost:8765/?api=http://localhost:8765 --
Schreibzugriffe landen in PFAD/vault, genau wie spaeter im Repository.
Schreiben erlaubt nur das Token "test-token-rw"; jedes andere Token darf lesen,
bekommt beim Schreiben aber 403 wie ein fine-grained Token ohne Schreibrecht.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

TOKEN_RW = "test-token-rw"
OWNER, REPO = "temmchen", "pfa"


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class Handler(SimpleHTTPRequestHandler):
    docs = "."

    def log_message(self, fmt, *args):  # kuerzeres Log
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    # ---- CORS ----
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Accept, Content-Type, X-GitHub-Api-Version")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "X-RateLimit-Remaining, Retry-After")
        self.send_header("X-RateLimit-Remaining", "4999")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def end_headers(self):
        if not self.path.startswith("/repos/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- Antworten ----
    def antwort(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def token(self):
        auth = self.headers.get("Authorization", "")
        return auth.replace("Bearer ", "").strip()

    def repo_pfad(self):
        """/repos/o/r/contents/<path> -> lokaler Pfad unterhalb docs (Repo-Pfad beginnt mit docs/)."""
        p = unquote(urlparse(self.path).path)
        prefix = f"/repos/{OWNER}/{REPO}/contents/"
        if not p.startswith(prefix):
            return None
        rel = p[len(prefix):]
        if rel.startswith("docs/"):
            rel = rel[len("docs/"):]
        return os.path.normpath(os.path.join(self.docs, rel))

    def do_GET(self):
        p = urlparse(self.path).path
        if p == f"/repos/{OWNER}/{REPO}":
            return self.antwort(200, {"default_branch": "main", "private": False})
        if p.startswith(f"/repos/{OWNER}/{REPO}/contents/"):
            lokal = self.repo_pfad()
            if os.path.isdir(lokal):
                eintraege = []
                for name in sorted(os.listdir(lokal)):
                    f = os.path.join(lokal, name)
                    if os.path.isfile(f):
                        data = open(f, "rb").read()
                        eintraege.append({"name": name, "type": "file", "sha": blob_sha(data), "size": len(data),
                                          "path": os.path.relpath(f, self.docs)})
                return self.antwort(200, eintraege)
            if not os.path.isfile(lokal):
                return self.antwort(404, {"message": "Not Found"})
            data = open(lokal, "rb").read()
            return self.antwort(200, {"name": os.path.basename(lokal), "type": "file", "sha": blob_sha(data),
                                      "size": len(data), "encoding": "base64",
                                      "content": base64.b64encode(data).decode("ascii")})
        if p.startswith("/repos/"):
            return self.antwort(404, {"message": "Not Found"})
        return super().do_GET()

    def lese_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_PUT(self):
        lokal = self.repo_pfad()
        if lokal is None:
            return self.antwort(404, {"message": "Not Found"})
        if self.token() != TOKEN_RW:
            return self.antwort(403, {"message": "Resource not accessible by personal access token"})
        body = self.lese_body()
        neu = base64.b64decode(body.get("content", ""))
        if os.path.isfile(lokal):
            aktuell = blob_sha(open(lokal, "rb").read())
            if "sha" not in body:
                return self.antwort(422, {"message": "Invalid request.\n\n\"sha\" wasn't supplied."})
            if body["sha"] != aktuell:
                return self.antwort(409, {"message": f"{lokal} does not match {body['sha']}"})
            status = 200
        else:
            status = 201
        os.makedirs(os.path.dirname(lokal), exist_ok=True)
        with open(lokal, "wb") as f:
            f.write(neu)
        sys.stderr.write(f"   -> geschrieben {os.path.relpath(lokal, self.docs)} ({len(neu)} B): {body.get('message')}\n")
        return self.antwort(status, {"content": {"sha": blob_sha(neu), "path": os.path.relpath(lokal, self.docs)},
                                     "commit": {"sha": "0" * 40}})

    def do_DELETE(self):
        lokal = self.repo_pfad()
        if lokal is None:
            return self.antwort(404, {"message": "Not Found"})
        if self.token() != TOKEN_RW:
            return self.antwort(403, {"message": "Resource not accessible by personal access token"})
        body = self.lese_body()
        if not os.path.isfile(lokal):
            return self.antwort(404, {"message": "Not Found"})
        if body.get("sha") != blob_sha(open(lokal, "rb").read()):
            return self.antwort(409, {"message": "sha mismatch"})
        os.remove(lokal)
        sys.stderr.write(f"   -> geloescht {os.path.relpath(lokal, self.docs)}: {body.get('message')}\n")
        return self.antwort(200, {"content": None, "commit": {"sha": "0" * 40}})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", required=True)
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    Handler.docs = os.path.abspath(a.docs)
    os.chdir(Handler.docs)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    sys.stderr.write(f"PFA-Testserver: http://localhost:{a.port}/?api=http://localhost:{a.port}  (docs: {Handler.docs})\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
