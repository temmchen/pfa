/*
 * PFA – Personal Finance Assistant: Kern
 * --------------------------------------
 * Ein Login fuer beide Bereiche (Finanzen + Honorare). Alle Daten liegen als
 * PFA1-Dateien verschluesselt im Repository (docs/vault/), der Datenschluessel
 * (DEK) wird beim Entsperren aus dem Schluesselbund (keyring.json) ausgepackt.
 *
 * Lesen: von der veroeffentlichten Seite (kein Token noetig).
 * Schreiben: ueber die GitHub-Contents-API mit einem Fine-grained-Token
 * ("Verwaltung"). Das Token kann -- mit dem DEK verschluesselt -- fuer diese
 * Sitzung oder dauerhaft auf diesem Geraet gemerkt werden.
 *
 * Module (finanz.js, honorar.js) registrieren sich mit Pfa.register(name, {
 *   load(obj|null), daten(), render(), flush(), lock(), adminChanged(aktiv),
 *   kennzahl() -> {wert, text} fuer die Home-Kachel
 * }).
 */
"use strict";

const Pfa = (() => {
  const CONFIG = {
    owner: "temmchen",
    repo: "pfa",
    vaultDir: "docs/vault",
    branch: "",                       // leer = Standard-Branch
    api: "https://api.github.com",
  };
  // Testbetrieb: ?api=http://localhost:8765 lenkt die GitHub-API auf einen Mock um.
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get("api") && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(qs.get("api"))) {
      CONFIG.api = qs.get("api");
    }
  } catch { /* egal */ }

  const AUTO_LOCK_MS = 10 * 60 * 1000;
  const LS_THEME = "pfa-theme";
  const LS_TOKEN = "pfa-token-geraet";    // Token, mit dem DEK verschluesselt (dauerhaft, dieses Geraet)
  const SS_TOKEN = "pfa-token-sitzung";   // Token, mit dem DEK verschluesselt (nur diese Browser-Sitzung)
  const SS_DEK = "pfa-sitzung";           // roher DEK fuer "angemeldet bleiben" (nur diese Browser-Sitzung)
  const LS_LOCKOUT = "pfa-lockout";
  const ALT_FINANZ = "finanz-dashboard-v1"; // Altbestand des frueheren Finanz-Dashboards (gleicher Origin)
  const MIN_PASS = 12;

  const state = {
    dek: null,
    keyring: null,
    keyringSha: null,
    admin: { token: null, branch: null, active: false },
    files: {},                        // name -> {sha}
    view: "home",
    lockTimer: null,
    blobUrls: [],
    entsperrt: false,
  };
  const module = {};                  // name -> Modul-Objekt
  const REIHENFOLGE = ["finanz", "honorar"];

  /* ================= Hilfsfunktionen ================= */

  const $ = (id) => document.getElementById(id);
  const txtEnc = new TextEncoder();
  const txtDec = new TextDecoder();
  const fmtEUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}.${m}.${y}`;
  }
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const jetzt = () => new Date().toISOString();

  /* toast(text)                      – kurze Meldung
   * toast(text, 6000)                – Meldung mit Dauer (Honorar-Stil)
   * toast(text, "err")               – Fehler
   * toast(text, "", {text, fn})      – mit Aktion (z. B. Rückgängig) */
  function toast(text, a, b, c) {
    let art = "", aktion = null, ms = 0;
    if (typeof a === "number") { ms = a; }
    else { art = a || ""; if (b && typeof b === "object") aktion = b; else if (typeof b === "number") ms = b; }
    if (typeof c === "number") ms = c;
    const box = $("toasts");
    const el = document.createElement("div");
    el.className = "toast" + (art === "err" ? " err" : "");
    el.append(document.createTextNode(text));
    if (aktion) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = aktion.text;
      btn.onclick = () => { aktion.fn(); el.remove(); };
      el.append(btn);
    }
    box.append(el);
    while (box.children.length > 4) box.firstChild.remove();
    const dauer = ms || (aktion ? 7000 : art === "err" ? 5500 : 3200);
    setTimeout(() => {
      el.style.transition = "opacity .3s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }, dauer);
  }

  function busy(text) {
    if (text === false) { $("busyOverlay").hidden = true; return; }
    $("busyText").textContent = text;
    $("busyOverlay").hidden = false;
  }

  /* ================= Fehlversuchs-Bremse ================= */

  function getLockout() {
    try { return JSON.parse(localStorage.getItem(LS_LOCKOUT)) || { n: 0, until: 0 }; }
    catch { return { n: 0, until: 0 }; }
  }
  function setLockout(v) { try { localStorage.setItem(LS_LOCKOUT, JSON.stringify(v)); } catch { /* egal */ } }
  function lockoutRemaining() { return Math.max(0, getLockout().until - Date.now()); }
  function registerFail() {
    const lo = getLockout();
    lo.n += 1;
    if (lo.n >= 5) lo.until = Date.now() + Math.min(30000 * 2 ** (lo.n - 5), 10 * 60 * 1000);
    setLockout(lo);
  }
  const clearFails = () => setLockout({ n: 0, until: 0 });

  /* ================= GitHub-API ================= */

  async function gh(path, opts = {}) {
    const resp = await fetch(`${CONFIG.api}${path}`, {
      cache: "no-store",
      ...opts,
      headers: {
        Authorization: `Bearer ${state.admin.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.json()).message || ""; } catch { /* egal */ }
      const err = new Error(`GitHub-API ${resp.status}: ${detail || resp.statusText}`);
      err.status = resp.status;
      err.rateLimited = (resp.status === 403 || resp.status === 429) &&
        (resp.headers.get("x-ratelimit-remaining") === "0" ||
         !!resp.headers.get("retry-after") || /rate limit/i.test(detail));
      if (err.rateLimited) {
        err.message = "GitHub-Anfragelimit erreicht – bitte in ein paar Minuten erneut versuchen.";
      } else if (resp.status === 403 && /not accessible by (personal access token|integration)/i.test(detail)) {
        err.tokenBerechtigung = true;
        err.message = tokenBerechtigungsHinweis();
      }
      throw err;
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  function tokenBerechtigungsHinweis() {
    return `Das GitHub-Token darf in ${CONFIG.owner}/${CONFIG.repo} nicht schreiben. ` +
      "Nötig ist ein fine-grained Token, dessen „Repository access“ dieses Repository enthält " +
      "und das die Berechtigung „Contents: Read and write“ hat – ein reines Lese-Token " +
      "(z. B. nur „Metadata“) reicht nicht. Anlegen unter github.com/settings/personal-access-tokens.";
  }

  const repoPath = (p) => `/repos/${CONFIG.owner}/${CONFIG.repo}/${p}`;

  async function ghGetFileBytes(path) {
    const ref = encodeURIComponent(state.admin.branch);
    const meta = await gh(repoPath(`contents/${path}?ref=${ref}`));
    if (meta.content && meta.encoding === "base64") {
      return { bytes: PfaCrypto.vonB64(meta.content), sha: meta.sha };
    }
    const blob = await gh(repoPath(`git/blobs/${meta.sha}`));   // > 1 MB
    return { bytes: PfaCrypto.vonB64(blob.content), sha: meta.sha };
  }

  async function ghPutFile(path, bytes, message, sha) {
    const body = { message, content: PfaCrypto.b64(bytes), branch: state.admin.branch };
    if (sha) body.sha = sha;
    return gh(repoPath(`contents/${path}`), { method: "PUT", body: JSON.stringify(body) });
  }

  async function ghDeleteFile(path, message, sha) {
    return gh(repoPath(`contents/${path}`), {
      method: "DELETE",
      body: JSON.stringify({ message, sha, branch: state.admin.branch }),
    });
  }

  async function ghGetSha(path) {
    try {
      const ref = encodeURIComponent(state.admin.branch);
      return (await gh(repoPath(`contents/${path}?ref=${ref}`))).sha;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async function ghListDir(path) {
    try {
      const ref = encodeURIComponent(state.admin.branch);
      const liste = await gh(repoPath(`contents/${path}?ref=${ref}`));
      return Array.isArray(liste) ? liste : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  /** PUT mit einmaligem Retry bei veraltetem SHA (Inhalt haengt nicht vom Remote-Stand ab). */
  async function ghPutFileFreshSha(path, bytes, message, sha) {
    try {
      return await ghPutFile(path, bytes, message, sha);
    } catch (e) {
      if (e.status === 409 || e.status === 422) {
        const fresh = await ghGetSha(path);
        return ghPutFile(path, bytes, message, fresh || undefined);
      }
      throw e;
    }
  }

  /* Schreibrecht pruefen, OHNE etwas zu schreiben: PUT mit garantiert falschem sha.
   * Mit Schreibrecht antwortet GitHub 409/422 (kein Commit); ohne 403/404. */
  async function ghProbeWrite(path, bytes, sha) {
    const echt = sha || "0".repeat(40);
    const falsch = echt.slice(0, -1) + (echt.endsWith("0") ? "1" : "0");
    try {
      const resp = await ghPutFile(path, bytes, "Verify write access (probe, content unchanged)", falsch);
      console.warn("Schreibprobe wurde angenommen – Commit mit unverändertem Inhalt erzeugt.");
      return resp && resp.content ? resp.content.sha : null;
    } catch (e) {
      if (e.status === 409 || e.status === 422) return null;
      if (e.rateLimited || e.status === 429) return null;
      if (e.status === 403 || e.status === 404) {
        e.probe = true;
        e.tokenBerechtigung = true;
        e.message = tokenBerechtigungsHinweis();
        throw e;
      }
      return null;
    }
  }

  /* ================= Vault-Dateien ================= */

  /** Liest eine Vault-Datei (Pfad relativ zu vault/). null = gibt es nicht. */
  async function dateiLesen(name) {
    if (state.admin.active) {
      try { return await ghGetFileBytes(`${CONFIG.vaultDir}/${name}`); }
      catch (e) { if (e.status === 404) return null; throw e; }
    }
    const resp = await fetch(`vault/${name}?ts=${Date.now()}`, { cache: "no-store" });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Vault-Datei ${name} konnte nicht geladen werden (HTTP ${resp.status}).`);
    return { bytes: new Uint8Array(await resp.arrayBuffer()), sha: null };
  }

  async function keyringLaden() {
    const d = await dateiLesen("keyring.json");
    if (!d) { state.keyring = null; state.keyringSha = null; return null; }
    let o = null;
    try { o = JSON.parse(txtDec.decode(d.bytes)); } catch { /* unten */ }
    if (!o || o.format !== "pfa-keyring" || !o.huellen || !o.huellen.pw) {
      throw new Error("Der Schlüsselbund (vault/keyring.json) ist unlesbar.");
    }
    state.keyring = o;
    state.keyringSha = d.sha;
    return o;
  }

  async function keyringSchreiben(message) {
    const path = `${CONFIG.vaultDir}/keyring.json`;
    const bytes = txtEnc.encode(JSON.stringify(state.keyring, null, 2));
    const sha = state.keyringSha || (await ghGetSha(path));
    const resp = await ghPutFileFreshSha(path, bytes, message, sha || undefined);
    state.keyringSha = resp.content.sha;
  }

  function dateiSha(name) {
    if (!state.files[name]) state.files[name] = { sha: null };
    return state.files[name];
  }

  /** Laedt alle Modul-Daten (entschluesselt) und uebergibt sie den Modulen. */
  async function datenLaden() {
    for (const name of REIHENFOLGE) {
      if (!module[name]) continue;
      const d = await dateiLesen(`${name}.enc`);
      let obj = null;
      if (d) {
        obj = await PfaCrypto.entschluesselnJson(state.dek, d.bytes);
        dateiSha(name).sha = d.sha;
      } else {
        dateiSha(name).sha = null;
      }
      module[name].load(obj);
    }
  }

  /** Speichert die Daten eines Moduls verschluesselt im Repository. */
  async function speichern(name, obj, message) {
    if (!state.admin.active) {
      const e = new Error("Zum Speichern bitte oben „Verwaltung“ aktivieren (GitHub-Token).");
      e.keinAdmin = true;
      throw e;
    }
    const enc = await PfaCrypto.verschluesselnJson(state.dek, obj);
    const path = `${CONFIG.vaultDir}/${name}.enc`;
    const eintrag = dateiSha(name);
    try {
      const resp = await ghPutFile(path, enc, message || `Update ${name}`, eintrag.sha || undefined);
      eintrag.sha = resp.content.sha;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && !/rule violation|protected branch/i.test(e.message)) {
        try {
          const d = await ghGetFileBytes(path);
          const remote = await PfaCrypto.entschluesselnJson(state.dek, d.bytes);
          eintrag.sha = d.sha;
          module[name].load(remote);
          module[name].render();
        } catch { /* best effort */ }
        const err = new Error(
          "Der Vault wurde zwischenzeitlich an anderer Stelle geändert. " +
          "Der aktuelle Stand wurde neu geladen – bitte die letzte Änderung noch einmal ausführen.");
        err.vaultReloaded = true;
        throw err;
      }
      throw e;
    }
  }

  const pdfPfad = (file) => `${CONFIG.vaultDir}/pdf/${file}`;

  async function pdfLesen(file) {
    const d = await dateiLesen(`pdf/${encodeURIComponent(file)}`);
    if (!d) throw new Error("PDF nicht gefunden. Nach einem Upload dauert die Veröffentlichung 1–2 Minuten.");
    return PfaCrypto.entschluesselnBytes(state.dek, d.bytes);
  }

  async function pdfSchreiben(file, plainBytes, message) {
    const enc = await PfaCrypto.verschluesselnBytes(state.dek, plainBytes);
    const path = pdfPfad(file);
    const sha = await ghGetSha(path);
    return ghPutFileFreshSha(path, enc, message || "Add encrypted PDF", sha || undefined);
  }

  async function pdfLoeschen(file, message) {
    const path = pdfPfad(file);
    const sha = await ghGetSha(path);
    if (sha) await ghDeleteFile(path, message || "Remove encrypted PDF", sha);
  }

  /* ================= Verwaltung (GitHub-Token) ================= */

  async function tokenMerken(token, wo) {
    try {
      const enc = PfaCrypto.b64(await PfaCrypto.verschluesselnBytes(state.dek, txtEnc.encode(token)));
      if (wo === "geraet") localStorage.setItem(LS_TOKEN, enc); else localStorage.removeItem(LS_TOKEN);
      if (wo === "sitzung") sessionStorage.setItem(SS_TOKEN, enc); else sessionStorage.removeItem(SS_TOKEN);
    } catch { /* Merken ist optional */ }
  }

  function tokenVergessen() {
    try { localStorage.removeItem(LS_TOKEN); } catch { /* egal */ }
    try { sessionStorage.removeItem(SS_TOKEN); } catch { /* egal */ }
  }

  async function tokenGemerkt() {
    for (const [store, key] of [[sessionStorage, SS_TOKEN], [localStorage, LS_TOKEN]]) {
      let v = null;
      try { v = store.getItem(key); } catch { continue; }
      if (!v) continue;
      try {
        return txtDec.decode(await PfaCrypto.entschluesselnBytes(state.dek, PfaCrypto.vonB64(v)));
      } catch {
        try { store.removeItem(key); } catch { /* egal */ }
      }
    }
    return null;
  }

  function tokenGemerktWo() {
    try { if (localStorage.getItem(LS_TOKEN)) return "geraet"; } catch { /* egal */ }
    try { if (sessionStorage.getItem(SS_TOKEN)) return "sitzung"; } catch { /* egal */ }
    return "nein";
  }

  async function activateAdmin(token, { probe = true, neuLaden = true } = {}) {
    state.admin.token = token;
    const repo = await gh(`/repos/${CONFIG.owner}/${CONFIG.repo}`);
    state.admin.branch = CONFIG.branch || repo.default_branch;
    if (probe) {
      // Schreibprobe auf keyring.json – oder auf docs/index.html, wenn der
      // Schluesselbund noch nicht existiert (Ersteinrichtung).
      let pfad = `${CONFIG.vaultDir}/keyring.json`;
      let d = null;
      try { d = await ghGetFileBytes(pfad); } catch (e) { if (e.status !== 404) throw e; }
      if (!d) { pfad = "docs/index.html"; d = await ghGetFileBytes(pfad); }
      const neu = await ghProbeWrite(pfad, d.bytes, d.sha);
      if (pfad.endsWith("keyring.json")) state.keyringSha = neu || d.sha;
    }
    state.admin.active = true;
    if (state.entsperrt && neuLaden) {
      // Autoritative Daten direkt aus dem Repo – die Seite kann 1–2 Minuten hinterherhinken.
      await keyringLaden();
      await datenLaden();
      for (const m of Object.values(module)) if (m.adminChanged) m.adminChanged(true);
      renderAktuell();
    }
    adminAnzeigen();
  }

  function deactivateAdmin() {
    state.admin = { token: null, branch: null, active: false };
    for (const m of Object.values(module)) if (m.adminChanged) m.adminChanged(false);
    adminAnzeigen();
    renderAktuell();
  }

  function adminAnzeigen() {
    const btn = $("btnAdmin");
    if (!btn) return;
    btn.classList.toggle("on", state.admin.active);
    btn.title = state.admin.active
      ? `Verwaltung aktiv – Änderungen werden in ${CONFIG.owner}/${CONFIG.repo} gespeichert`
      : "Verwaltung aktivieren (GitHub-Token), um Änderungen zu speichern";
    $("btnAdminText").textContent = state.admin.active ? "Verwaltung aktiv" : "Verwaltung";
    const hinweis = $("adminHinweis");
    if (hinweis) hinweis.hidden = state.admin.active;
  }

  /** true, wenn gespeichert werden kann; sonst Hinweis und false. */
  function requireAdmin() {
    if (state.admin.active) return true;
    toast("Zum Speichern bitte oben „Verwaltung“ aktivieren (GitHub-Token).", "err");
    return false;
  }

  /* ================= Sperren / Entsperren ================= */

  async function entsperren(passphrase, merken) {
    if (!state.keyring) await keyringLaden();
    if (!state.keyring) throw new Error("Es gibt noch keinen Schlüsselbund – bitte zuerst einrichten.");
    const dek = await PfaCrypto.huelleOeffnen(state.keyring.huellen.pw, passphrase);
    await entsperrenMit(dek, merken);
  }

  async function entsperrenMit(dek, merken) {
    state.dek = dek;
    await datenLaden();
    state.entsperrt = true;
    try {
      if (merken) sessionStorage.setItem(SS_DEK, await PfaCrypto.exportRoh(dek));
      else sessionStorage.removeItem(SS_DEK);
    } catch { /* egal */ }
    $("gate").hidden = true;
    $("app").hidden = false;
    go("home");
    armAutoLock();
    adminAnzeigen();
    // Gemerktes Token wiederherstellen (verschluesselt abgelegt)
    const t = state.admin.active ? null : await tokenGemerkt();
    if (t) {
      activateAdmin(t).then(() => {
        toast("Verwaltung aktiv – Änderungen werden gespeichert.");
      }).catch((e) => {
        state.admin = { token: null, branch: null, active: false };
        adminAnzeigen();
        if (e && (e.tokenBerechtigung || e.status === 401 || e.status === 403 || e.status === 404)) {
          tokenVergessen();
          toast("Gemerktes Token nicht mehr gültig – bitte unter „Verwaltung“ ein neues eintragen.", "err", 8000);
        }
      });
    }
  }

  function lock(info) {
    state.dek = null;
    state.entsperrt = false;
    state.admin = { token: null, branch: null, active: false };
    try { sessionStorage.removeItem(SS_DEK); } catch { /* egal */ }
    for (const m of Object.values(module)) if (m.lock) m.lock();
    for (const url of state.blobUrls) URL.revokeObjectURL(url);
    state.blobUrls = [];
    clearTimeout(state.lockTimer);
    for (const dlg of document.querySelectorAll("dialog[open]")) dlg.close();
    for (const o of document.querySelectorAll(".ovl")) o.hidden = true;
    for (const f of document.querySelectorAll("form")) f.reset();
    for (const i of document.querySelectorAll("input[type=password]")) i.value = "";
    $("app").hidden = true;
    zeige("gLogin");
    if (info) {
      const h = $("gLoginHinweis");
      h.textContent = info;
      h.hidden = false;
    }
  }

  function armAutoLock() {
    clearTimeout(state.lockTimer);
    state.lockTimer = setTimeout(() => {
      if (state.dek) lock("Aus Sicherheitsgründen automatisch gesperrt.");
    }, AUTO_LOCK_MS);
  }
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, () => { if (state.dek) armAutoLock(); }, { passive: true }));

  async function sichernUndBeenden() {
    if (!state.dek) return;
    busy("Wird gesichert …");
    try {
      for (const m of Object.values(module)) if (m.flush) await m.flush();
      lock("Gesichert und gesperrt. Bis zum nächsten Mal!");
    } catch (e) {
      toast(`Sichern fehlgeschlagen: ${e.message} – nicht gesperrt, damit nichts verloren geht.`, "err", 8000);
    } finally {
      busy(false);
    }
  }

  /* ================= Einrichtung / Wiederherstellung / Neuanfang ================= */

  function keyringNeu(pwHuelle, wkHuelle) {
    return {
      format: "pfa-keyring", version: 1, erstellt: jetzt(), geaendert: null,
      huellen: { pw: pwHuelle, wk: wkHuelle },
    };
  }

  /** Legt Schluesselbund + leere Vaults an. Verwaltung muss aktiv sein. Gibt den Wiederherstellungsschluessel zurueck. */
  async function einrichten(passphrase, fortschritt) {
    const melde = (t) => { if (fortschritt) fortschritt(t); };
    melde("Datenschlüssel wird erzeugt …");
    const dek = await PfaCrypto.neuerSchluessel();
    const rk = PfaCrypto.neuerWiederherstellungsschluessel();
    state.keyring = keyringNeu(
      await PfaCrypto.huelleBauen(dek, passphrase),
      await PfaCrypto.huelleBauen(dek, PfaCrypto.rkNorm(rk)));
    state.dek = dek;
    melde("Schlüsselbund wird gespeichert …");
    await keyringSchreiben("PFA: Schlüsselbund angelegt");
    for (const name of REIHENFOLGE) {
      if (!module[name]) continue;
      melde(`Bereich „${name}“ wird angelegt …`);
      module[name].load(null);
      dateiSha(name).sha = await ghGetSha(`${CONFIG.vaultDir}/${name}.enc`);
      await speichern(name, module[name].daten(), `PFA: ${name} angelegt`);
    }
    return rk;
  }

  /** Alles loeschen und mit neuer Passphrase neu beginnen (ohne alte Passphrase). */
  async function neuAnfangen(passphrase, fortschritt) {
    const melde = (t) => { if (fortschritt) fortschritt(t); };
    melde("Alte Dateien werden entfernt …");
    const pdfs = (await ghListDir(`${CONFIG.vaultDir}/pdf`)).filter((f) => f.type === "file" && f.name.endsWith(".enc"));
    let n = 0;
    for (const d of pdfs) {
      melde(`PDF ${++n} von ${pdfs.length} wird entfernt …`);
      await ghDeleteFile(`${CONFIG.vaultDir}/pdf/${d.name}`, "Reset: remove encrypted PDF", d.sha);
    }
    state.keyringSha = await ghGetSha(`${CONFIG.vaultDir}/keyring.json`);
    tokenVergessen();   // war mit dem alten DEK verschluesselt
    const rk = await einrichten(passphrase, fortschritt);
    return { rk, pdfs: pdfs.length };
  }

  async function passphraseAendern(alt, neu) {
    await PfaCrypto.huelleOeffnen(state.keyring.huellen.pw, alt);     // wirft DecryptError
    state.keyring.huellen.pw = await PfaCrypto.huelleBauen(state.dek, neu);
    state.keyring.geaendert = jetzt();
    await keyringSchreiben("PFA: Passphrase geändert");
  }

  async function wiederherstellungNeu(passphrase) {
    await PfaCrypto.huelleOeffnen(state.keyring.huellen.pw, passphrase);
    const rk = PfaCrypto.neuerWiederherstellungsschluessel();
    state.keyring.huellen.wk = await PfaCrypto.huelleBauen(state.dek, PfaCrypto.rkNorm(rk));
    state.keyring.geaendert = jetzt();
    await keyringSchreiben("PFA: Wiederherstellungsschlüssel erneuert");
    return rk;
  }

  /* ================= Sicherungsdateien (beide Bereiche) ================= */

  /* Format "pfa-sicherung": JSON mit den Huellen des Schluesselbunds (oeffnet
   * sich also mit Passphrase ODER Wiederherstellungsschluessel) und einem mit
   * dem DEK verschluesselten Paket. Mit eigener Passphrase wird stattdessen ein
   * frischer Sicherungsschluessel verwendet -- der DEK verlaesst den Vault nicht. */
  async function sicherungBauen(modul, nutzlast, eigenePass) {
    const s = { format: "pfa-sicherung", version: 1, erstellt: jetzt(), modul, huellen: {}, daten: null };
    if (eigenePass) {
      const bk = await PfaCrypto.neuerSchluessel();
      s.huellen.pw = await PfaCrypto.huelleBauen(bk, eigenePass);
      s.daten = await PfaCrypto.paketBauen(bk, nutzlast);
    } else {
      s.huellen = { pw: state.keyring.huellen.pw, wk: state.keyring.huellen.wk };
      s.daten = await PfaCrypto.paketBauen(state.dek, nutzlast);
    }
    return JSON.stringify(s);
  }

  const istSicherung = (o) => !!o && o.format === "pfa-sicherung" && !!o.huellen && !!o.huellen.pw && !!o.daten;
  const istAltFinanzTresor = (o) => !!o && o.format === "finanz-dashboard-tresor" && !!o.huellen && !!o.huellen.pw;

  /** Oeffnet eine Sicherung: erst mit dem eigenen DEK (gleicher Schluesselbund), sonst mit Geheimnis. */
  async function sicherungOeffnen(o, geheim) {
    const eigene = state.keyring && o.huellen.pw && o.huellen.pw.paket === state.keyring.huellen.pw.paket;
    if (eigene && state.dek) return PfaCrypto.paketOeffnen(state.dek, o.daten);
    if (!geheim) { const e = new Error("Passphrase dieser Sicherung nötig."); e.brauchtGeheimnis = true; throw e; }
    let key;
    try { key = await PfaCrypto.huelleOeffnen(o.huellen.pw, geheim); }
    catch (e) {
      if (o.huellen.wk) { try { key = await PfaCrypto.huelleOeffnen(o.huellen.wk, PfaCrypto.rkNorm(geheim)); } catch { /* unten */ } }
      if (!key) throw new PfaCrypto.DecryptError("Passphrase (oder Wiederherstellungsschlüssel) passt nicht zu dieser Sicherung.");
    }
    return PfaCrypto.paketOeffnen(key, o.daten);
  }

  /** Altbestand des frueheren Finanz-Dashboards im Browser-Speicher (gleicher Origin). */
  function altFinanzTresor() {
    try {
      const roh = localStorage.getItem(ALT_FINANZ);
      if (!roh) return null;
      const o = JSON.parse(roh);
      return istAltFinanzTresor(o) ? o : null;
    } catch { return null; }
  }
  function altFinanzEntfernen() { try { localStorage.removeItem(ALT_FINANZ); } catch { /* egal */ } }

  /* ================= Navigation ================= */

  function go(view) {
    if (!state.dek) return;
    state.view = view;
    for (const v of ["home", "finanz", "honorar"]) {
      const el = $("view" + v[0].toUpperCase() + v.slice(1));
      if (el) el.hidden = v !== view;
      const nb = $("nav" + v[0].toUpperCase() + v.slice(1));
      if (nb) nb.classList.toggle("on", v === view);
    }
    document.title = view === "home" ? "PFA – Personal Finance Assistant"
      : view === "finanz" ? "PFA – Finanzen" : "PFA – Honorare";
    window.scrollTo(0, 0);
    renderAktuell();
  }

  function renderAktuell() {
    if (!state.dek) return;
    if (state.view === "home") homeRender();
    else if (module[state.view]) module[state.view].render();
  }

  function homeRender() {
    for (const name of REIHENFOLGE) {
      const m = module[name];
      if (!m || !m.kennzahl) continue;
      const k = m.kennzahl();
      const wert = $("home" + name[0].toUpperCase() + name.slice(1) + "Wert");
      const text = $("home" + name[0].toUpperCase() + name.slice(1) + "Text");
      if (wert) { wert.textContent = k.wert; wert.className = "tile-val num " + (k.klasse || ""); }
      if (text) text.textContent = k.text;
    }
    const d = new Date();
    $("homeDatum").textContent = d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  /* ================= Theme ================= */

  function themeSetzen(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(LS_THEME, t); } catch { /* egal */ }
    const icon = $("themeIcon");
    if (icon) icon.innerHTML = t === "dark"
      ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
      : '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';
  }
  function themeStart() {
    let t = null;
    try { t = localStorage.getItem(LS_THEME); } catch { /* egal */ }
    themeSetzen(t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }

  /* ================= Anmelde-Ansichten ================= */

  const ANSICHTEN = ["gSetup", "gKey", "gLogin", "gReset", "gNeu", "gKaputt"];

  function staerkeZuruecksetzen(wurzel) {
    for (const bar of wurzel.querySelectorAll(".stark i")) bar.style.width = "0";
    for (const t of wurzel.querySelectorAll(".starktxt")) t.textContent = "";
  }

  function zeige(welche) {
    for (const id of ANSICHTEN) {
      const el = $(id);
      if (!el) continue;
      el.hidden = id !== welche;
      const f = el.querySelector(".gfehler"); if (f) f.hidden = true;
      if (id === welche) staerkeZuruecksetzen(el);
    }
    if (welche !== "gLogin") { const h = $("gLoginHinweis"); if (h) h.hidden = true; }
    $("gate").hidden = false;
    $("app").hidden = true;
    const erstes = document.querySelector("#" + welche + " input:not([type=checkbox]):not([type=radio]):not([hidden])");
    if (erstes) setTimeout(() => erstes.focus(), 40);
  }

  function gFehler(formId, text) {
    const el = document.querySelector("#" + formId + " .gfehler");
    el.textContent = text;
    el.hidden = false;
  }

  async function mitWarten(form, fn) {
    const b = form.querySelector("button[type=submit]");
    const beschriftung = b.textContent;
    b.disabled = true;
    b.textContent = "Einen Moment …";
    try { return await fn(); } finally { b.disabled = false; b.textContent = beschriftung; }
  }

  function tokenFehlerText(err) {
    return err.status === 401 ? "Token ungültig oder abgelaufen." :
      err.rateLimited || err.tokenBerechtigung ? err.message :
      err.status === 403 || err.status === 404
        ? "Token hat keinen Zugriff auf dieses Repository (Berechtigung „Contents: Read & Write“ nötig)."
        : err.message;
  }

  function schluesselZeigen(rk, weiterText) {
    $("rkText").textContent = rk;
    $("gKeyWeiter").textContent = weiterText || "Weiter zur App";
    zeige("gKey");
  }

  function register(name, m) { module[name] = m; }

  /* ================= Start ================= */

  async function start() {
    themeStart();
    if (!window.crypto || !crypto.subtle) {
      $("gate").hidden = false;
      $("gate").innerHTML = '<div class="gcard"><h2>Verschlüsselung nicht verfügbar</h2>' +
        '<p class="lead">Dieser Browser stellt die Web-Crypto-Schnittstelle nicht bereit. ' +
        'Bitte die Seite über <b>https://</b> aufrufen oder einen aktuellen Browser verwenden.</p></div>';
      return;
    }
    let kr = null;
    try { kr = await keyringLaden(); }
    catch (e) {
      zeige("gKaputt");
      $("gKaputtText").textContent = e.message;
      return;
    }
    if (!kr) { zeige("gSetup"); return; }
    // "Angemeldet bleiben": roher DEK aus der Browser-Sitzung
    let sk = null;
    try { sk = sessionStorage.getItem(SS_DEK); } catch { /* egal */ }
    if (sk) {
      try {
        const dek = await PfaCrypto.importRoh(sk);
        await entsperrenMit(dek, true);
        return;
      } catch { try { sessionStorage.removeItem(SS_DEK); } catch { /* egal */ } }
    }
    zeige("gLogin");
  }

  document.addEventListener("DOMContentLoaded", () => {
    // ---- Anmelden ----
    $("gLogin").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const wait = lockoutRemaining();
      if (wait > 0) return gFehler("gLogin", `Zu viele Fehlversuche – bitte ${Math.ceil(wait / 1000)} Sekunden warten.`);
      if (!f.pw.value) return;
      await mitWarten(ev.target, async () => {
        try {
          await entsperren(f.pw.value, f.merken.checked);
          clearFails();
          f.pw.value = "";
        } catch (e) {
          if (e instanceof PfaCrypto.DecryptError) { registerFail(); gFehler("gLogin", "Falsche Passphrase."); }
          else gFehler("gLogin", e.message);
        }
      });
    });

    // ---- Einrichten (erster Start) ----
    $("gSetup").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      if (f.pw1.value.length < MIN_PASS) return gFehler("gSetup", `Bitte mindestens ${MIN_PASS} Zeichen verwenden.`);
      if (f.pw1.value !== f.pw2.value) return gFehler("gSetup", "Die beiden Passphrasen stimmen nicht überein.");
      if (!f.token.value.trim()) return gFehler("gSetup", "Ohne GitHub-Token lässt sich der Schlüsselbund nicht speichern.");
      await mitWarten(ev.target, async () => {
        const prog = $("gSetupProgress");
        prog.hidden = false;
        try {
          prog.textContent = "Token wird geprüft …";
          await activateAdmin(f.token.value.trim(), { neuLaden: false });
          const rk = await einrichten(f.pw1.value, (t) => { prog.textContent = t; });
          await tokenMerken(f.token.value.trim(), f.merken.value);
          f.pw1.value = f.pw2.value = f.token.value = "";
          schluesselZeigen(rk, "Weiter zur App");
        } catch (e) {
          state.admin = { token: null, branch: null, active: false };
          gFehler("gSetup", e.status || e.tokenBerechtigung ? tokenFehlerText(e) : "Einrichtung fehlgeschlagen: " + e.message);
        } finally { prog.hidden = true; }
      });
    });

    // ---- Wiederherstellungsschluessel gesichert -> App ----
    $("gKey").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      $("rkText").textContent = "";
      ev.target.reset();
      await entsperrenMit(state.dek, false);
    });
    $("rkCopy").onclick = async () => {
      try { await navigator.clipboard.writeText($("rkText").textContent); toast("Schlüssel in die Zwischenablage kopiert."); }
      catch { toast("Zwischenablage nicht verfügbar – bitte abschreiben.", "err"); }
    };
    $("rkSave").onclick = () => {
      const text = "Wiederherstellungsschlüssel für PFA – Personal Finance Assistant\r\n" +
        "Erstellt am " + new Date().toLocaleString("de-DE") + "\r\n\r\n" +
        $("rkText").textContent + "\r\n\r\n" +
        "Damit lässt sich eine neue Passphrase setzen, ohne Daten zu verlieren.\r\n" +
        "Bitte getrennt von der Passphrase aufbewahren.\r\n";
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "PFA-Wiederherstellungsschluessel.txt";
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast("Als Textdatei gespeichert.");
    };

    // ---- Passphrase vergessen: Wiederherstellungsschluessel ----
    $("gReset").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const nurEntsperren = ev.submitter && ev.submitter.id === "gResetNur";
      if (!nurEntsperren) {
        if (f.pw1.value.length < MIN_PASS) return gFehler("gReset", `Die neue Passphrase braucht mindestens ${MIN_PASS} Zeichen.`);
        if (f.pw1.value !== f.pw2.value) return gFehler("gReset", "Die beiden Passphrasen stimmen nicht überein.");
        if (!f.token.value.trim()) return gFehler("gReset", "Zum Speichern der neuen Passphrase wird das GitHub-Token gebraucht – oder unten „Nur entsperren“ wählen.");
      }
      const knopf = nurEntsperren ? $("gResetNur") : ev.target.querySelector("button[type=submit]:not(#gResetNur)");
      const alt = knopf.textContent; knopf.disabled = true; knopf.textContent = "Einen Moment …";
      try {
        if (!state.keyring) await keyringLaden();
        if (!state.keyring || !state.keyring.huellen.wk) return gFehler("gReset", "Für diesen Schlüsselbund gibt es keinen Wiederherstellungsschlüssel.");
        let dek;
        try { dek = await PfaCrypto.huelleOeffnen(state.keyring.huellen.wk, PfaCrypto.rkNorm(f.rk.value)); }
        catch { registerFail(); return gFehler("gReset", "Dieser Wiederherstellungsschlüssel passt nicht."); }
        if (!nurEntsperren) {
          await activateAdmin(f.token.value.trim(), { neuLaden: false });
          state.dek = dek;
          state.keyring.huellen.pw = await PfaCrypto.huelleBauen(dek, f.pw1.value);
          state.keyring.geaendert = jetzt();
          await keyringSchreiben("PFA: Passphrase ersetzt");
          await tokenMerken(f.token.value.trim(), f.merken.value);
        }
        f.rk.value = f.pw1.value = f.pw2.value = f.token.value = "";
        await entsperrenMit(dek, false);
        clearFails();
        toast(nurEntsperren
          ? "Entsperrt. Die Passphrase kannst du unter „Verwaltung → Passphrase & Zugang“ neu setzen."
          : "Neue Passphrase gesetzt – alle Daten sind erhalten.", "", 6000);
      } catch (e) {
        state.admin = { token: null, branch: null, active: false };
        gFehler("gReset", e.status || e.tokenBerechtigung ? tokenFehlerText(e) : "Wiederherstellung fehlgeschlagen: " + e.message);
      } finally { knopf.disabled = false; knopf.textContent = alt; }
    });

    // ---- Neu anfangen (alles loeschen) ----
    $("gNeu").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const best = f.confirm.value.trim().toUpperCase().replace(/\s+/g, "");
      if (best !== "NEUANFANGEN") return gFehler("gNeu", "Bitte zur Bestätigung NEU ANFANGEN eintippen.");
      if (!f.token.value.trim()) return gFehler("gNeu", "Ohne GitHub-Token lässt sich nichts löschen.");
      if (f.pw1.value.length < MIN_PASS) return gFehler("gNeu", `Die neue Passphrase braucht mindestens ${MIN_PASS} Zeichen.`);
      if (f.pw1.value !== f.pw2.value) return gFehler("gNeu", "Die Passphrasen stimmen nicht überein.");
      await mitWarten(ev.target, async () => {
        const prog = $("gNeuProgress");
        prog.hidden = false;
        try {
          prog.textContent = "Token wird geprüft …";
          await activateAdmin(f.token.value.trim(), { neuLaden: false });
          const { rk } = await neuAnfangen(f.pw1.value, (t) => { prog.textContent = t; });
          await tokenMerken(f.token.value.trim(), f.merken.value);
          f.pw1.value = f.pw2.value = f.token.value = f.confirm.value = "";
          schluesselZeigen(rk, "Weiter zur leeren App");
        } catch (e) {
          state.admin = { token: null, branch: null, active: false };
          gFehler("gNeu", e.status || e.tokenBerechtigung ? tokenFehlerText(e) : "Neuanfang fehlgeschlagen: " + e.message);
        } finally { prog.hidden = true; }
      });
    });

    // ---- Verweise unter den Formularen ----
    for (const b of document.querySelectorAll("#gate .glink")) {
      b.onclick = () => {
        const akt = b.dataset.akt;
        if (akt === "reset") zeige("gReset");
        else if (akt === "login") zeige("gLogin");
        else if (akt === "neu") zeige("gNeu");
      };
    }

    // ---- Passphrasenstaerke ----
    for (const id of ["sPw1", "rPw1", "nPw1", "pwNeu1"]) {
      const inp = $(id);
      if (!inp) continue;
      inp.addEventListener("input", () => {
        const pw = inp.value, n = staerke(pw);
        const bar = inp.parentElement.querySelector(".stark i");
        const txt = inp.parentElement.querySelector(".starktxt");
        if (!bar) return;
        const farben = ["var(--db)", "var(--db)", "#e08a1e", "#e0b81e", "var(--cr)", "var(--cr)"];
        const worte = ["sehr schwach", "schwach", "geht so", "brauchbar", "stark", "sehr stark"];
        bar.style.width = (pw ? (n + 1) / 6 * 100 : 0) + "%";
        bar.style.background = farben[n];
        txt.textContent = pw
          ? "Stärke: " + worte[n] + (pw.length < MIN_PASS ? ` – mindestens ${MIN_PASS} Zeichen nötig` : "")
          : "Ein Satz aus mehreren Wörtern ist leicht zu merken und sicher.";
      });
    }

    // ---- Kopfleiste ----
    $("navHome").onclick = () => go("home");
    $("navFinanz").onclick = () => go("finanz");
    $("navHonorar").onclick = () => go("honorar");
    $("homeFinanz").onclick = () => go("finanz");
    $("homeHonorar").onclick = () => go("honorar");
    $("btnTheme").onclick = () => themeSetzen(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    $("btnLock").onclick = () => lock();
    $("btnExit").onclick = sichernUndBeenden;
    $("homeExit").onclick = sichernUndBeenden;

    // ---- Verwaltung (Token) ----
    $("btnAdmin").onclick = () => {
      $("adminError").hidden = true;
      $("adminForm").reset();
      $("adminAktiv").hidden = !state.admin.active;
      $("adminForm").hidden = state.admin.active;
      if (state.admin.active) {
        $("adminBranchInfo").textContent = `${CONFIG.owner}/${CONFIG.repo} · Branch: ${state.admin.branch}` +
          ({ geraet: " · Token auf diesem Gerät gemerkt", sitzung: " · Token für diese Sitzung gemerkt", nein: "" }[tokenGemerktWo()]);
      }
      $("adminDialog").showModal();
    };
    $("adminForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const errEl = $("adminError");
      errEl.hidden = true;
      try {
        busy("Verbinde mit GitHub …");
        await activateAdmin(form.token.value.trim());
        await tokenMerken(form.token.value.trim(), form.merken.value);
        form.reset();
        $("adminDialog").close();
        toast("Verwaltung aktiv – Änderungen werden gespeichert.");
      } catch (err) {
        state.admin = { token: null, branch: null, active: false };
        adminAnzeigen();
        errEl.textContent = tokenFehlerText(err);
        errEl.hidden = false;
      } finally { busy(false); }
    });
    $("adminOffBtn").onclick = () => { deactivateAdmin(); $("adminDialog").close(); toast("Verwaltung beendet – nur noch Ansicht."); };
    $("adminForgetBtn").onclick = () => { tokenVergessen(); deactivateAdmin(); $("adminDialog").close(); toast("Token vergessen."); };
    $("adminPassBtn").onclick = () => {
      $("adminDialog").close();
      for (const i of document.querySelectorAll("#passDialog input")) i.value = "";
      for (const f of document.querySelectorAll("#passDialog .gfehler")) f.hidden = true;
      staerkeZuruecksetzen($("passDialog"));
      $("rkNeuBox").hidden = true;
      $("passDialog").showModal();
    };
    for (const btn of document.querySelectorAll("[data-close]")) {
      btn.addEventListener("click", () => { const d = $(btn.dataset.close); if (d && d.open) d.close(); });
    }

    // ---- Passphrase & Zugang ----
    $("fPwChange").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const fehler = (t) => { const el = ev.target.querySelector(".gfehler"); el.textContent = t; el.hidden = false; };
      ev.target.querySelector(".gfehler").hidden = true;
      if (f.neu1.value.length < MIN_PASS) return fehler(`Die neue Passphrase braucht mindestens ${MIN_PASS} Zeichen.`);
      if (f.neu1.value !== f.neu2.value) return fehler("Die beiden neuen Passphrasen stimmen nicht überein.");
      if (!state.admin.active) return fehler("Bitte zuerst die Verwaltung aktivieren (GitHub-Token) – der Schlüsselbund wird im Repository gespeichert.");
      await mitWarten(ev.target, async () => {
        try {
          await passphraseAendern(f.alt.value, f.neu1.value);
          ev.target.reset();
          $("passDialog").close();
          toast("Passphrase geändert. Der Wiederherstellungsschlüssel gilt weiterhin. Die öffentliche Seite übernimmt es in 1–2 Minuten.", "", 7000);
        } catch (e) {
          fehler(e instanceof PfaCrypto.DecryptError ? "Die aktuelle Passphrase ist falsch." : "Fehlgeschlagen: " + e.message);
        }
      });
    });
    $("fRkNeu").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const fehler = (t) => { const el = ev.target.querySelector(".gfehler"); el.textContent = t; el.hidden = false; };
      ev.target.querySelector(".gfehler").hidden = true;
      if (!state.admin.active) return fehler("Bitte zuerst die Verwaltung aktivieren (GitHub-Token).");
      await mitWarten(ev.target, async () => {
        try {
          const rk = await wiederherstellungNeu(f.pw.value);
          const box = $("rkNeuBox");
          box.textContent = rk; box.hidden = false;
          f.pw.value = "";
          toast("Neuer Schlüssel erzeugt – der alte gilt nicht mehr. Bitte jetzt notieren!", "", 7000);
        } catch (e) {
          fehler(e instanceof PfaCrypto.DecryptError ? "Die Passphrase ist falsch." : "Fehlgeschlagen: " + e.message);
        }
      });
    });

    // Escape schliesst Overlays der Module
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const offen = document.querySelector(".ovl:not([hidden])");
      if (offen) offen.hidden = true;
    });

    start();
  });

  function staerke(pw) {
    let p = 0;
    if (pw.length >= 8) p++;
    if (pw.length >= 12) p++;
    if (pw.length >= 16) p++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) p++;
    if (/\d/.test(pw)) p++;
    if (/[^\w\s]/.test(pw)) p++;
    return Math.min(p, 5);
  }

  return {
    CONFIG, state, register,
    $, esc, fmtDate, todayIso, fmtEUR, toast, busy,
    gh, repoPath, ghGetFileBytes, ghPutFile, ghDeleteFile, ghGetSha, ghListDir, ghPutFileFreshSha,
    dateiLesen, speichern, pdfLesen, pdfSchreiben, pdfLoeschen, pdfPfad,
    requireAdmin, go, renderAktuell, armAutoLock, lock,
    sicherungBauen, sicherungOeffnen, istSicherung, istAltFinanzTresor,
    altFinanzTresor, altFinanzEntfernen,
    get dek() { return state.dek; },
    get adminAktiv() { return state.admin.active; },
    blobUrl(blob) { const u = URL.createObjectURL(blob); state.blobUrls.push(u); return u; },
  };
})();
