/*
 * PFA – Bereich Finanzen (privates Budget)
 * Credit (Einnahmen) links · Debit (Ausgaben) rechts · Kategorien · Monatsverlauf
 * Speicherung: verschluesselt im Repository ueber Pfa.speichern("finanz", …).
 */
"use strict";

const Finanz = (() => {
  const { $, toast, esc } = Pfa;

  const KAT_STD = {
    credit: ["Gehalt", "Nebeneinkünfte", "Erstattung", "Zinsen", "Verkauf", "Sonstiges"],
    debit: ["Miete", "Nebenkosten", "Versicherung", "Lebensmittel", "Auto/Transport",
      "Telefon/Internet", "Abos", "Freizeit", "Gesundheit", "Kleidung", "Sparen", "Sonstiges"],
  };

  const leer = () => ({
    version: 1,
    titel: "Bilanzierung — Einnahmen & Ausgaben",
    waehrung: "EUR",
    startkapital: 0,
    eintraege: [],
  });

  let data = leer();                 /* entschluesselt, nur im Arbeitsspeicher */
  const ui = { zeit: "alle", kat: "", suche: "", sort: "datum-desc", edit: null };
  const sichtbar = () => Pfa.state.view === "finanz";

  /* ---------- Normalisierung ---------- */

  function normalisieren(d) {
    const base = leer();
    if (!d || typeof d !== "object") return base;
    const out = Object.assign(base, {
      titel: typeof d.titel === "string" ? d.titel : base.titel,
      waehrung: typeof d.waehrung === "string" ? d.waehrung : "EUR",
      startkapital: Number(d.startkapital) || 0,
      eintraege: [],
    });
    const list = Array.isArray(d.eintraege) ? d.eintraege : (Array.isArray(d) ? d : []);
    out.eintraege = list.map(normEintrag).filter(Boolean);
    return out;
  }
  function normEintrag(e) {
    if (!e || typeof e !== "object") return null;
    const betrag = Math.abs(Number(e.betrag));
    if (!isFinite(betrag)) return null;
    const label = String(e.label ?? "").trim();
    if (!label && !betrag) return null;
    return {
      id: String(e.id || uid()),
      typ: e.typ === "credit" ? "credit" : "debit",
      label: label || "(ohne Bezeichnung)",
      betrag: Math.round(betrag * 100) / 100,
      datum: istDatum(e.datum) ? e.datum : heute(),
      kategorie: String(e.kategorie ?? "").trim(),
      notiz: String(e.notiz ?? "").trim(),
      fix: !!e.fix,
    };
  }

  /* ---------- Speichern (gebuendelt, ueber den Kern) ---------- */

  let speicherTimer = null, speicherKette = Promise.resolve(), ausstehend = false;

  const darf = () => Pfa.requireAdmin();

  /* Aufrufer bleiben synchron: das Verschluesseln + Hochladen wird gebuendelt nachgezogen. */
  function speichern() {
    ausstehend = true;
    clearTimeout(speicherTimer);
    speicherTimer = setTimeout(jetztSpeichern, 900);
  }
  function jetztSpeichern() {
    clearTimeout(speicherTimer);
    if (!ausstehend) return speicherKette;
    ausstehend = false;
    speicherKette = speicherKette
      .then(() => Pfa.speichern("finanz", data, "Update finanz"))
      .catch((e) => {
        if (!e.vaultReloaded) ausstehend = true;      // beim naechsten Mal erneut versuchen
        toast("Finanzen: Speichern fehlgeschlagen – " + e.message, "err", 8000);
      });
    return speicherKette;
  }
  async function flush() {
    await jetztSpeichern();
    if (ausstehend) throw new Error("Finanzen: Änderungen konnten nicht gespeichert werden.");
  }

  /* ---------- Helfer ---------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function heute() { return new Date().toISOString().slice(0, 10); }
  function istDatum(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function fmt(n) {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: data.waehrung || "EUR" })
      .format(isFinite(n) ? n : 0);
  }
  function fmtDatum(s) {
    if (!istDatum(s)) return "";
    const [y, m, d] = s.split("-");
    return d + "." + m + "." + y;
  }
  function monatName(key) {
    const [y, m] = key.split("-");
    return new Date(+y, +m - 1, 1).toLocaleDateString("de-DE", { month: "short" }) + " " + y;
  }

  /* Betrag lesen: "1.234,56" · "1234.56" · "12,50" · auch Rechnungen wie "45+12,90" */
  function parseBetrag(v) {
    if (typeof v === "number") return isFinite(v) ? Math.round(v * 100) / 100 : NaN;
    let t = String(v ?? "").trim().replace(/[€$£\s ']/g, "");
    if (!t) return NaN;
    if (!/^[0-9+\-*/().,]+$/.test(t)) return NaN;
    const komma = t.lastIndexOf(","), punkt = t.lastIndexOf(".");
    if (komma > -1 && punkt > -1) {
      t = komma > punkt ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    } else if (komma > -1) {
      t = t.replace(/\./g, "").replace(/,/g, ".");
    }
    try {
      const val = Function('"use strict";return (' + t + ")")();
      return (typeof val === "number" && isFinite(val)) ? Math.round(val * 100) / 100 : NaN;
    } catch (e) { return NaN; }
  }

  /* ---------- Filterung ---------- */
  function gefiltert() {
    const q = ui.suche.trim().toLowerCase();
    const list = data.eintraege.filter((e) => {
      if (ui.zeit !== "alle") {
        if (ui.zeit.length === 7 && e.datum.slice(0, 7) !== ui.zeit) return false;
        if (ui.zeit.length === 4 && e.datum.slice(0, 4) !== ui.zeit) return false;
      }
      if (ui.kat && (e.kategorie || "(ohne)") !== ui.kat) return false;
      if (q && !(e.label + " " + e.kategorie + " " + e.notiz).toLowerCase().includes(q)) return false;
      return true;
    });
    const [feld, richtung] = ui.sort.split("-");
    const vz = richtung === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let r = 0;
      if (feld === "betrag") r = a.betrag - b.betrag;
      else if (feld === "label") r = a.label.localeCompare(b.label, "de");
      else r = a.datum.localeCompare(b.datum) || a.label.localeCompare(b.label, "de");
      return r * vz;
    });
    return list;
  }
  const summe = (list) => list.reduce((s, e) => s + e.betrag, 0);

  /* ---------- Rendern ---------- */
  /* Hinweis auf den Altbestand des frueheren Finanz-Dashboards – nur solange er weder uebernommen noch verworfen ist. */
  function altBanner() { $("altFinanzBanner").hidden = !Pfa.altFinanzOffen(); }

  function render() {
    $("subtitle").textContent = data.titel;
    const nurAnsicht = !Pfa.adminAktiv;
    $("viewFinanz").classList.toggle("nurAnsicht", nurAnsicht);
    for (const el of document.querySelectorAll("#viewFinanz form.addform input, #viewFinanz form.addform button")) {
      el.disabled = nurAnsicht;
    }
    altBanner();

    const list = gefiltert();
    const cs = list.filter((e) => e.typ === "credit");
    const ds = list.filter((e) => e.typ === "debit");
    const sc = summe(cs), sd = summe(ds), saldo = sc - sd;

    $("kCredit").textContent = fmt(sc);
    $("kDebit").textContent = fmt(sd);
    $("kCreditSub").textContent =
      cs.length ? cs.length + " Buchung" + (cs.length > 1 ? "en" : "") + " · Ø " + fmt(sc / cs.length) : "noch nichts erfasst";
    $("kDebitSub").textContent =
      ds.length ? ds.length + " Buchung" + (ds.length > 1 ? "en" : "") + " · Ø " + fmt(sd / ds.length) : "noch nichts erfasst";

    const kS = $("kSaldo");
    kS.textContent = fmt(saldo);
    kS.className = "val num " + (saldo < 0 ? "neg" : "pos");
    const quote = sc > 0 ? (saldo / sc * 100) : 0;
    $("kSaldoSub").textContent = sc > 0
      ? (saldo >= 0 ? "Sparquote " + quote.toFixed(1).replace(".", ",") + " % der Einnahmen"
        : "Unterdeckung von " + Math.abs(quote).toFixed(1).replace(".", ",") + " % der Einnahmen")
      : (sd > 0 ? "nur Ausgaben erfasst" : "noch keine Buchungen");
    $("kBar").style.width = Math.max(0, Math.min(100, quote)) + "%";
    $("kBar").style.background = saldo < 0 ? "var(--db)" : "var(--cr)";

    const kk = $("kpiKonto");
    if (data.startkapital) {
      kk.hidden = false;
      const ges = data.startkapital + data.eintraege.reduce((s, e) => s + (e.typ === "credit" ? e.betrag : -e.betrag), 0);
      $("kKonto").textContent = fmt(ges);
      $("kKonto").style.color = ges < 0 ? "var(--db)" : "var(--txt)";
      $("kKontoSub").textContent = "Startkapital " + fmt(data.startkapital) + " + alle Buchungen";
    } else kk.hidden = true;

    $("sumC").textContent = fmt(sc);
    $("sumD").textContent = fmt(sd);
    $("cntC").textContent = cs.length;
    $("cntD").textContent = ds.length;
    zeichneListe("listC", cs, sc, "credit");
    zeichneListe("listD", ds, sd, "debit");

    const anteil = (s) => { const ges = sc + sd; return ges > 0 ? (s / ges * 100).toFixed(0) + " % des Volumens" : "—"; };
    $("footC").textContent = cs.length ? anteil(sc) : "Keine Buchungen";
    $("footD").textContent = ds.length ? anteil(sd) : "Keine Buchungen";
    $("footCavg").textContent = cs.length ? "größter Posten " + fmt(Math.max(...cs.map((e) => e.betrag))) : "";
    $("footDavg").textContent = ds.length ? "größter Posten " + fmt(Math.max(...ds.map((e) => e.betrag))) : "";

    zeichneKategorien(cs, ds, sc, sd);
    zeichneVerlauf();
    fuelleSelects();
  }

  function zeichneListe(id, list, gesamt, typ) {
    const ul = $(id);
    ul.innerHTML = "";
    if (!list.length && ui.edit === null) {
      ul.innerHTML = '<li class="empty"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/>'
        + '<path d="M3 10h18M8 3v4M16 3v4"/></svg><div>Noch keine ' +
        (typ === "credit" ? "Einnahmen" : "Ausgaben") + " in dieser Ansicht</div></li>";
      return;
    }
    for (const e of list) {
      if (ui.edit === e.id) { ul.append(editZeile(e)); continue; }
      const li = document.createElement("li");
      li.className = "row"; li.dataset.id = e.id;
      const p = gesamt > 0 ? (e.betrag / gesamt * 100) : 0;
      li.innerHTML =
        '<div class="rmain">' +
          '<div class="rlabel">' + esc(e.label) + "</div>" +
          '<div class="rmeta">' +
            (e.kategorie ? '<span class="chip">' + esc(e.kategorie) + "</span>" : "") +
            "<span>" + fmtDatum(e.datum) + "</span>" +
            (e.fix ? '<span title="wiederkehrender Posten">🔁</span>' : "") +
          "</div>" +
          (e.notiz ? '<div class="rnote" title="' + esc(e.notiz) + '">' + esc(e.notiz) + "</div>" : "") +
        "</div>" +
        '<span class="pct num">' + p.toFixed(0) + "%</span>" +
        '<div class="ramt num">' + fmt(e.betrag) + "</div>" +
        '<div class="ract">' +
          '<button data-act="fix" class="' + (e.fix ? "on" : "") + '" title="Als wiederkehrend markieren">' +
            '<svg class="icn" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/>' +
            '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg></button>' +
          '<button data-act="dup" title="Duplizieren">' +
            '<svg class="icn" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/>' +
            '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
          '<button data-act="edit" title="Bearbeiten">' +
            '<svg class="icn" viewBox="0 0 24 24"><path d="M12 20h9"/>' +
            '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
          '<button data-act="del" class="d" title="Löschen">' +
            '<svg class="icn" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/>' +
            '<path d="M19 6l-1 14H6L5 6"/></svg></button>' +
        "</div>";
      ul.append(li);
    }
  }

  function editZeile(e) {
    const li = document.createElement("li");
    li.className = "editrow";
    li.innerHTML =
      '<form class="editform" data-id="' + e.id + '">' +
        '<div class="editgrid">' +
          '<input name="label" value="' + esc(e.label) + '" required placeholder="Bezeichnung">' +
          '<input name="betrag" value="' + String(e.betrag).replace(".", ",") + '" inputmode="decimal" required>' +
          '<div class="two">' +
            '<input name="datum" type="date" value="' + esc(e.datum) + '">' +
            '<input name="kategorie" value="' + esc(e.kategorie) + '" placeholder="Kategorie" list="kat' +
              (e.typ === "credit" ? "Credit" : "Debit") + '">' +
          "</div>" +
          '<input class="full" name="notiz" value="' + esc(e.notiz) + '" placeholder="Notiz (optional)">' +
        "</div>" +
        '<div class="editact">' +
          '<button type="button" data-act="swap">Auf die andere Seite</button>' +
          '<button type="button" data-act="cancel">Abbrechen</button>' +
          '<button type="submit" class="pri">Speichern</button>' +
        "</div>" +
      "</form>";
    return li;
  }

  function zeichneKategorien(cs, ds, sc, sd) {
    const bau = (list, gesamt, klasse) => {
      if (!list.length) return '<div style="color:var(--txt3);font-size:12.5px">—</div>';
      const m = new Map();
      for (const e of list) {
        const k = e.kategorie || "Ohne Kategorie";
        m.set(k, (m.get(k) || 0) + e.betrag);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        '<div class="catrow ' + klasse + '">' +
          '<div class="t"><b>' + esc(k) + '</b><span class="num">' + fmt(v) + " · " +
            (gesamt > 0 ? (v / gesamt * 100).toFixed(0) : 0) + " %</span></div>" +
          '<div class="track"><i style="width:' + (gesamt > 0 ? v / gesamt * 100 : 0) + '%"></i></div>' +
        "</div>").join("");
    };
    $("catC").innerHTML = bau(cs, sc, "c");
    $("catD").innerHTML = bau(ds, sd, "d");
    $("katHint").textContent =
      ui.zeit === "alle" ? "alle Buchungen" : (ui.zeit.length === 7 ? monatName(ui.zeit) : "Jahr " + ui.zeit);
  }

  function zeichneVerlauf() {
    const box = $("chart");
    const m = new Map();
    for (const e of data.eintraege) {
      const k = e.datum.slice(0, 7);
      if (!m.has(k)) m.set(k, { c: 0, d: 0 });
      m.get(k)[e.typ === "credit" ? "c" : "d"] += e.betrag;
    }
    const keys = [...m.keys()].sort().slice(-12);
    if (!keys.length) {
      box.innerHTML = '<div class="empty" style="margin:auto">Noch keine Daten für den Verlauf</div>';
      return;
    }
    const max = Math.max(...keys.map((k) => Math.max(m.get(k).c, m.get(k).d)), 1);
    box.innerHTML = keys.map((k) => {
      const v = m.get(k), s = v.c - v.d;
      return '<div class="mcol">' +
        '<div class="mbars">' +
          '<div class="mbar c" style="height:' + (v.c / max * 100) + '%" title="Einnahmen ' + fmt(v.c) + '"></div>' +
          '<div class="mbar d" style="height:' + (v.d / max * 100) + '%" title="Ausgaben ' + fmt(v.d) + '"></div>' +
        "</div>" +
        '<div class="mlab"><b>' + monatName(k) + "</b>" +
          '<span class="s num ' + (s < 0 ? "neg" : "pos") + '">' + fmt(s) + "</span></div>" +
      "</div>";
    }).join("");
  }

  function fuelleSelects() {
    const sel = $("fZeit");
    const monate = [...new Set(data.eintraege.map((e) => e.datum.slice(0, 7)))].sort().reverse();
    const jahre = [...new Set(monate.map((k) => k.slice(0, 4)))];
    const jetzt = heute().slice(0, 7);
    if (!monate.includes(jetzt)) monate.unshift(jetzt);
    let html = '<option value="alle">Alle Buchungen</option>';
    if (jahre.length) html += '<optgroup label="Jahre">' +
      jahre.map((j) => '<option value="' + j + '">Jahr ' + j + "</option>").join("") + "</optgroup>";
    html += '<optgroup label="Monate">' +
      monate.map((k) => '<option value="' + k + '">' + monatName(k) + "</option>").join("") + "</optgroup>";
    sel.innerHTML = html;
    sel.value = ui.zeit;
    if (!sel.value) { ui.zeit = "alle"; sel.value = "alle"; }

    const kats = [...new Set(data.eintraege.map((e) => e.kategorie || "(ohne)"))].sort((a, b) => a.localeCompare(b, "de"));
    const kSel = $("fKat");
    kSel.innerHTML = '<option value="">Alle Kategorien</option>' +
      kats.map((k) => '<option value="' + esc(k) + '">' + esc(k) + "</option>").join("");
    kSel.value = kats.includes(ui.kat) ? ui.kat : "";
    if (!kSel.value) ui.kat = "";

    for (const typ of ["credit", "debit"]) {
      const eigen = [...new Set(data.eintraege.filter((e) => e.typ === typ).map((e) => e.kategorie).filter(Boolean))];
      const alle = [...new Set([...eigen, ...KAT_STD[typ]])];
      $("kat" + (typ === "credit" ? "Credit" : "Debit")).innerHTML =
        alle.map((k) => '<option value="' + esc(k) + '">').join("");
    }
  }

  /* ---------- Aktionen ---------- */
  function hinzufuegen(typ, f) {
    if (!darf()) return;
    const betrag = parseBetrag(f.betrag.value);
    if (!isFinite(betrag) || betrag === 0) {
      toast("Bitte einen gültigen Betrag eingeben (z. B. 1.250,00).", "err");
      f.betrag.focus(); return;
    }
    const e = normEintrag({
      typ, label: f.label.value.trim() || "(ohne Bezeichnung)",
      betrag: Math.abs(betrag),
      datum: f.datum.value || heute(),
      kategorie: f.kategorie.value.trim(),
    });
    data.eintraege.push(e);
    speichern(); render();
    f.label.value = ""; f.betrag.value = "";
    f.label.focus();
  }

  function loeschen(id) {
    if (!darf()) return;
    const i = data.eintraege.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [weg] = data.eintraege.splice(i, 1);
    speichern(); render();
    toast("„" + weg.label + "“ gelöscht.", "", {
      text: "Rückgängig",
      fn: () => { data.eintraege.splice(i, 0, weg); speichern(); render(); },
    });
  }

  /* ---------- Ereignisse: Formulare & Listen ---------- */
  document.querySelectorAll("#viewFinanz form.addform").forEach((f) => {
    f.addEventListener("submit", (ev) => { ev.preventDefault(); hinzufuegen(f.dataset.typ, f.elements); });
  });

  document.querySelector("#viewFinanz .boards").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest(".row");
    const form = btn.closest("form.editform");
    const id = row ? row.dataset.id : (form ? form.dataset.id : null);
    if (!id) return;
    const e = data.eintraege.find((x) => x.id === id);
    if (!e) return;

    switch (btn.dataset.act) {
      case "del": loeschen(id); break;
      case "edit":
        if (!darf()) return;
        ui.edit = id; render();
        setTimeout(() => { const i = document.querySelector(".editform input[name=label]"); if (i) { i.focus(); i.select(); } }, 0);
        break;
      case "cancel": ui.edit = null; render(); break;
      case "fix": if (!darf()) return; e.fix = !e.fix; speichern(); render(); break;
      case "dup": {
        if (!darf()) return;
        const kopie = Object.assign({}, e, { id: uid() });
        data.eintraege.push(kopie); speichern(); render();
        toast("Buchung dupliziert."); break;
      }
      case "swap": {
        if (!darf()) return;
        e.typ = e.typ === "credit" ? "debit" : "credit";
        ui.edit = null; speichern(); render();
        toast("Auf die andere Seite verschoben."); break;
      }
    }
  });

  document.querySelector("#viewFinanz .boards").addEventListener("submit", (ev) => {
    const f = ev.target.closest("form.editform");
    if (!f) return;
    ev.preventDefault();
    if (!darf()) return;
    const e = data.eintraege.find((x) => x.id === f.dataset.id);
    if (!e) return;
    const betrag = parseBetrag(f.elements.betrag.value);
    if (!isFinite(betrag) || betrag === 0) { toast("Ungültiger Betrag.", "err"); return; }
    e.label = f.elements.label.value.trim() || "(ohne Bezeichnung)";
    e.betrag = Math.abs(betrag);
    e.datum = f.elements.datum.value || e.datum;
    e.kategorie = f.elements.kategorie.value.trim();
    e.notiz = f.elements.notiz.value.trim();
    ui.edit = null; speichern(); render();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ui.edit && sichtbar()) { ui.edit = null; render(); }
  });

  /* ---------- Filter ---------- */
  $("fZeit").addEventListener("change", (e) => { ui.zeit = e.target.value; render(); });
  $("fKat").addEventListener("change", (e) => { ui.kat = e.target.value; render(); });
  $("fSort").addEventListener("change", (e) => { ui.sort = e.target.value; render(); });
  let sucheTimer;
  $("fSuche").addEventListener("input", (e) => {
    clearTimeout(sucheTimer);
    sucheTimer = setTimeout(() => { ui.suche = e.target.value; render(); }, 140);
  });
  $("btnReset").addEventListener("click", () => {
    ui.zeit = "alle"; ui.kat = ""; ui.suche = ""; ui.sort = "datum-desc";
    $("fSuche").value = "";
    $("fSort").value = "datum-desc";
    render();
  });

  /* ---------- Modale ---------- */
  function oeffne(id) { $(id).hidden = false; }
  document.querySelectorAll(".ovl").forEach((o) => {
    o.addEventListener("click", (ev) => {
      if (ev.target === o || ev.target.closest("[data-ovl]")) o.hidden = true;
    });
  });
  $("btnImport").onclick = () => {
    zumImport = null;
    $("impPw").hidden = true;
    oeffne("ovlImport");
  };
  $("btnExport").onclick = () => {
    $("expInfo").textContent =
      document.querySelector("input[name=escope]:checked").value === "filter"
        ? gefiltert().length + " gefilterte" : "alle " + data.eintraege.length;
    wohinHinweis();
    oeffne("ovlExport");
  };
  $("btnFix").onclick = () => { fixVorbereiten(); oeffne("ovlFix"); };
  $("btnSettings").onclick = () => {
    $("setTitel").value = data.titel;
    $("setWaehrung").value = data.waehrung;
    $("setStart").value = data.startkapital ? String(data.startkapital).replace(".", ",") : "";
    oeffne("ovlSet");
  };

  /* ---------- Einstellungen ---------- */
  $("setSave").onclick = () => {
    if (!darf()) return;
    data.titel = $("setTitel").value.trim() || "Bilanzierung — Einnahmen & Ausgaben";
    data.waehrung = $("setWaehrung").value;
    const s = parseBetrag($("setStart").value);
    data.startkapital = isFinite(s) ? s : 0;
    speichern(); render();
    $("ovlSet").hidden = true;
    toast("Einstellungen gespeichert.");
  };
  $("setClear").onclick = () => {
    if (!darf()) return;
    if (!confirm("Wirklich alle Buchungen löschen? (Rückgängig ist kurz möglich.)")) return;
    const sicherung = JSON.parse(JSON.stringify(data));
    data = leer(); speichern(); render();
    $("ovlSet").hidden = true;
    toast("Alle Buchungen gelöscht.", "", { text: "Rückgängig", fn: () => { data = sicherung; speichern(); render(); } });
  };
  $("setDemo").onclick = () => {
    if (!darf()) return;
    const sicherung = JSON.parse(JSON.stringify(data));
    const d = new Date(), mk = (n) => {
      const x = new Date(d.getFullYear(), d.getMonth() - n, Math.min(d.getDate(), 28));
      return x.toISOString().slice(0, 10);
    };
    const muster = [
      ["credit", "Gehalt", "Gehalt", 3850, true], ["credit", "Nebentätigkeit", "Nebeneinkünfte", 420, false],
      ["debit", "Miete inkl. NK", "Miete", 1180, true], ["debit", "Strom & Gas", "Nebenkosten", 145, true],
      ["debit", "Haftpflicht & Hausrat", "Versicherung", 62, true], ["debit", "Lebensmittel", "Lebensmittel", 480, false],
      ["debit", "Tanken", "Auto/Transport", 165, false], ["debit", "Internet & Mobil", "Telefon/Internet", 68, true],
      ["debit", "Streaming & Abos", "Abos", 34, true], ["debit", "Sparplan", "Sparen", 400, true],
      ["debit", "Restaurant & Freizeit", "Freizeit", 210, false],
    ];
    const neu = [];
    for (let n = 2; n >= 0; n--) {
      for (const [typ, label, kat, betrag, fix] of muster) {
        const jitter = fix ? 1 : (0.75 + Math.random() * 0.5);
        neu.push(normEintrag({ typ, label, kategorie: kat, betrag: Math.round(betrag * jitter * 100) / 100, datum: mk(n), fix }));
      }
    }
    data.eintraege = data.eintraege.concat(neu);
    speichern(); render();
    $("ovlSet").hidden = true;
    toast(neu.length + " Beispielbuchungen geladen.", "", { text: "Rückgängig", fn: () => { data = sicherung; speichern(); render(); } });
  };

  /* ---------- Export ---------- */
  function exportListe() {
    const scope = document.querySelector("input[name=escope]:checked").value;
    return scope === "filter" ? gefiltert() : data.eintraege.slice();
  }
  function stempel() { return new Date().toISOString().slice(0, 10); }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function alsJson() {
    return JSON.stringify({
      format: "pfa-finanz-klartext", version: 1, exportiert: new Date().toISOString(),
      titel: data.titel, waehrung: data.waehrung, startkapital: data.startkapital,
      eintraege: exportListe(),
    }, null, 2);
  }
  const csvFeld = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  function alsCsv() {
    const kopf = ["typ", "label", "betrag", "datum", "kategorie", "notiz", "fix"];
    const zeilen = exportListe().map((e) => [
      e.typ, e.label, String(e.betrag).replace(".", ","), e.datum, e.kategorie, e.notiz, e.fix ? "ja" : "",
    ].map(csvFeld).join(";"));
    return "﻿" + kopf.join(";") + "\r\n" + zeilen.join("\r\n") + "\r\n";
  }
  let pickerNutzbar = typeof window.showSaveFilePicker === "function";
  let letzterHandle = null, letzterTyp = null;

  const mimeVon = (typ) => typ === "csv" ? "text/csv" : "application/json";
  const endungVon = (typ) => typ === "csv" ? ".csv" : ".json";
  const namenVon = (typ) => (typ === "tresor" ? "finanzen-sicherung-" : "finanzen-") + stempel() + endungVon(typ);
  const titelVon = (typ) => typ === "csv" ? "CSV-Tabelle" : typ === "tresor" ? "Verschlüsselte Sicherung" : "JSON-Sicherung";

  /* Verschluesselte Sicherung: dieselben Huellen wie der Schluesselbund (oeffnet sich mit
     Passphrase oder Wiederherstellungsschluessel) -- oder mit eigener Passphrase. */
  async function alsTresor() {
    const eigene = $("expEigene").checked ? $("expEigenePass").value : "";
    if ($("expEigene").checked && eigene.length < 12) {
      throw new Error("Die eigene Passphrase braucht mindestens 12 Zeichen.");
    }
    return Pfa.sicherungBauen("finanz", {
      titel: data.titel, waehrung: data.waehrung,
      startkapital: data.startkapital, eintraege: exportListe(),
    }, eigene);
  }
  const inhalt = async (typ) => typ === "csv" ? alsCsv() : typ === "tresor" ? await alsTresor() : alsJson();

  async function speichernAls(typ) {
    let text;
    try { text = await inhalt(typ); }
    catch (e) { toast(e.message, "err"); $("expEigenePass").focus(); return; }
    const name = namenVon(typ), mime = mimeVon(typ);
    if (pickerNutzbar) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: titelVon(typ), accept: { [mime]: [endungVon(typ)] } }],
        });
        await schreibe(handle, text, mime);
        letzterHandle = handle; letzterTyp = typ;
        wohinHinweis();
        toast("Gespeichert als „" + handle.name + "“.");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
        pickerNutzbar = false;
      }
    }
    download(name, text, mime);
    wohinHinweis();
    toast("„" + name + "“ liegt im Download-Ordner deines Browsers.");
  }
  async function schreibe(handle, text, mime) {
    const w = await handle.createWritable();
    await w.write(new Blob([text], { type: mime + ";charset=utf-8" }));
    await w.close();
  }
  async function erneutSpeichern() {
    if (!letzterHandle) return;
    try {
      const opt = { mode: "readwrite" };
      if (letzterHandle.queryPermission) {
        let p = await letzterHandle.queryPermission(opt);
        if (p !== "granted") p = await letzterHandle.requestPermission(opt);
        if (p !== "granted") { toast("Zugriff auf die Datei wurde nicht erlaubt.", "err"); return; }
      }
      await schreibe(letzterHandle, await inhalt(letzterTyp), mimeVon(letzterTyp));
      toast("„" + letzterHandle.name + "“ aktualisiert.");
    } catch (err) {
      toast("Datei konnte nicht aktualisiert werden — bitte neu speichern.", "err");
      letzterHandle = null; wohinHinweis();
    }
  }
  function wohinHinweis() {
    $("expWohin").innerHTML = pickerNutzbar
      ? "<b>Wo landet die Datei?</b> Es öffnet sich ein Fenster, in dem du Ordner und Namen "
        + "frei wählst — du kannst sie also direkt in deinem OneDrive- oder Dokumente-Ordner ablegen."
      : "<b>Wo landet die Datei?</b> Dieser Browser fragt nicht nach, sondern legt sie sofort im "
        + "Download-Ordner ab (auf dem Mac normalerweise <code>~/Downloads</code>). "
        + "In Safari erreichst du sie über das Pfeil-Symbol oben rechts, in Chrome mit "
        + "<code>⌘⇧J</code>. Von dort verschiebst du sie in einen beliebigen Ordner.";
    const b = $("expWieder");
    b.hidden = !letzterHandle;
    if (letzterHandle) b.textContent = "„" + letzterHandle.name + "“ überschreiben (Sicherung aktualisieren)";
  }
  $("expTresor").onclick = () => speichernAls("tresor");
  $("expJson").onclick = () => speichernAls("json");
  $("expCsv").onclick = () => speichernAls("csv");
  $("expWieder").onclick = erneutSpeichern;
  $("expClip").onclick = async () => {
    try { await navigator.clipboard.writeText(alsJson()); toast("JSON in die Zwischenablage kopiert."); }
    catch (e) { toast("Zwischenablage nicht verfügbar — bitte Datei herunterladen.", "err"); }
  };
  $("expEigene").addEventListener("change", () => {
    $("expEigenePass").hidden = !$("expEigene").checked;
    if ($("expEigene").checked) $("expEigenePass").focus(); else $("expEigenePass").value = "";
  });
  document.querySelectorAll("input[name=escope]").forEach((r) => r.addEventListener("change", () => {
    $("expInfo").textContent =
      document.querySelector("input[name=escope]:checked").value === "filter"
        ? gefiltert().length + " gefilterte" : "alle " + data.eintraege.length;
  }));

  /* ---------- Import ---------- */
  let zumImport = null;    // {art:'pfa'|'alt', o}
  const fileInput = $("file");
  const drop = $("drop");
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) leseDatei(fileInput.files[0]); fileInput.value = ""; };
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) leseDatei(f); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!sichtbar()) return;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) { oeffne("ovlImport"); leseDatei(f); }
  });

  function leseDatei(f) {
    const r = new FileReader();
    r.onload = async () => {
      try {
        const txt = String(r.result).replace(/^﻿/, "");
        const istJson = /\.json$/i.test(f.name) || /^\s*[{[]/.test(txt);
        if (istJson) {
          let o = null; try { o = JSON.parse(txt); } catch (e) { /* unten */ }
          if (Pfa.istSicherung(o)) {
            if (o.modul && o.modul !== "finanz" && o.modul !== "alle") {
              toast("Das ist eine Honorar-Sicherung – bitte im Bereich Honorare importieren.", "err"); return;
            }
            zumImport = { art: "pfa", o };
            try {
              const roh = await Pfa.sicherungOeffnen(o);         // gleicher Schluesselbund?
              zumImport = null;
              sicherungUebernehmen(roh);
            } catch (e) {
              if (e.brauchtGeheimnis) importPasswortZeigen("Bitte die Passphrase (oder den Wiederherstellungsschlüssel) eingeben, mit der diese Sicherung gespeichert wurde.");
              else throw e;
            }
            return;
          }
          if (Pfa.istAltFinanzTresor(o)) {
            zumImport = { art: "alt", o };
            importPasswortZeigen("Sicherung des früheren Finanz-Dashboards erkannt. Bitte das damalige Passwort eingeben.");
            return;
          }
        }
        const eintraege = istJson ? ausJson(txt) : ausCsv(txt);
        if (!eintraege.length) { toast("Keine verwertbaren Buchungen in der Datei gefunden.", "err"); return; }
        let meta = null;
        if (istJson) { try { meta = JSON.parse(txt); } catch (e) { /* egal */ } }
        uebernehmen(eintraege, meta);
      } catch (err) {
        console.error(err);
        toast("Datei konnte nicht gelesen werden: " + err.message, "err");
      }
    };
    r.onerror = () => toast("Datei konnte nicht gelesen werden.", "err");
    r.readAsText(f, "utf-8");
  }
  function sicherungUebernehmen(roh) {
    const eintraege = (Array.isArray(roh.eintraege) ? roh.eintraege : []).map(normEintrag).filter(Boolean);
    if (!eintraege.length) { toast("In der Sicherung stehen keine Buchungen.", "err"); return; }
    uebernehmen(eintraege, roh);
  }
  function ausJson(txt) {
    const roh = JSON.parse(txt);
    const list = Array.isArray(roh) ? roh : (Array.isArray(roh.eintraege) ? roh.eintraege : []);
    return list.map(normEintrag).filter(Boolean);
  }
  function trennzeichen(kopf) {
    const kand = [";", "\t", ","];
    return kand.map((c) => [c, kopf.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  }
  function csvZeile(zeile, sep) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < zeile.length; i++) {
      const c = zeile[i];
      if (q) {
        if (c === '"') { if (zeile[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  function ausCsv(txt) {
    const zeilen = txt.split(/\r?\n/).filter((z) => z.trim());
    if (!zeilen.length) return [];
    const sep = trennzeichen(zeilen[0]);
    const kopf = csvZeile(zeilen[0], sep).map((h) => h.toLowerCase().replace(/^"|"$/g, ""));
    const finde = (...namen) => kopf.findIndex((h) => namen.some((n) => h.includes(n)));
    const iTyp = finde("typ", "art", "soll"),
      iLab = finde("label", "bezeichn", "beschreib", "verwendung", "text", "buchung", "name"),
      iBet = finde("betrag", "amount", "summe", "wert"),
      iDat = finde("datum", "date", "valuta"),
      iKat = finde("kategorie", "category", "gruppe"),
      iNot = finde("notiz", "note", "komment", "bemerkung"),
      iFix = finde("fix", "wiederk");
    const hatKopf = iBet > -1 || iLab > -1;
    const start = hatKopf ? 1 : 0;
    const out = [];
    for (let i = start; i < zeilen.length; i++) {
      const f = csvZeile(zeilen[i], sep);
      const rohBetrag = hatKopf ? f[iBet] : f[1];
      const betrag = parseBetrag(rohBetrag);
      if (!isFinite(betrag) || betrag === 0) continue;
      let typ;
      const tRoh = (hatKopf && iTyp > -1 ? f[iTyp] : "").toLowerCase();
      if (/credit|einnahm|ein|haben|\+/.test(tRoh)) typ = "credit";
      else if (/debit|ausgab|aus|soll|-/.test(tRoh)) typ = "debit";
      else typ = betrag > 0 ? "credit" : "debit";
      let datum = hatKopf && iDat > -1 ? f[iDat] : "";
      datum = datumLesen(datum);
      out.push(normEintrag({
        typ, betrag: Math.abs(betrag),
        label: (hatKopf ? f[iLab] : f[0]) || "(ohne Bezeichnung)",
        datum, kategorie: hatKopf && iKat > -1 ? f[iKat] : "",
        notiz: hatKopf && iNot > -1 ? f[iNot] : "",
        fix: hatKopf && iFix > -1 ? /ja|true|1|x/i.test(f[iFix] || "") : false,
      }));
    }
    return out.filter(Boolean);
  }
  function datumLesen(s) {
    s = String(s || "").trim();
    if (istDatum(s)) return s;
    let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = (+y > 70 ? "19" : "20") + y;
      return y + "-" + mo.padStart(2, "0") + "-" + d.padStart(2, "0");
    }
    m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
    return heute();
  }

  /** Neue Buchungen einarbeiten. meta: {titel, waehrung, startkapital} bei "Ersetzen". */
  function uebernehmen(neu, meta, modusVorgabe) {
    if (!darf()) return;
    const modus = modusVorgabe || document.querySelector("input[name=imode]:checked").value;
    const sicherung = JSON.parse(JSON.stringify(data));
    let zahl = neu.length, uebersprungen = 0;
    if (modus === "replace") {
      data.eintraege = neu;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        if (meta.titel) data.titel = meta.titel;
        if (meta.waehrung) data.waehrung = meta.waehrung;
        if (meta.startkapital != null) data.startkapital = Number(meta.startkapital) || 0;
      }
    } else {
      const bekannt = new Set(data.eintraege.map((e) => e.typ + "|" + e.label + "|" + e.betrag + "|" + e.datum));
      const frisch = [];
      for (const e of neu) {
        const k = e.typ + "|" + e.label + "|" + e.betrag + "|" + e.datum;
        if (bekannt.has(k)) { uebersprungen++; continue; }
        bekannt.add(k); frisch.push(e);
      }
      data.eintraege = data.eintraege.concat(frisch);
      zahl = frisch.length;
    }
    speichern(); render();
    $("ovlImport").hidden = true;
    $("ovlAlt").hidden = true;
    toast(zahl + " Buchung" + (zahl === 1 ? "" : "en") + " importiert" +
      (uebersprungen ? " · " + uebersprungen + " Duplikat(e) übersprungen" : "") + ".",
      "", { text: "Rückgängig", fn: () => { data = sicherung; speichern(); render(); } });
  }

  function importPasswortZeigen(text) {
    $("impPwText").textContent = text;
    $("impPw").hidden = false;
    const feld = $("impPwFeld");
    feld.value = ""; feld.focus();
  }
  $("impPwFeld").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("impPwGo").click(); } });
  $("impPwGo").onclick = async () => {
    if (!zumImport) return;
    const b = $("impPwGo");
    const beschriftung = b.textContent;
    b.disabled = true; b.textContent = "Einen Moment …";
    try {
      const pw = $("impPwFeld").value;
      let roh;
      try {
        if (zumImport.art === "alt") {
          roh = await altTresorOeffnen(zumImport.o, pw);
        } else {
          roh = await Pfa.sicherungOeffnen(zumImport.o, pw);
        }
      } catch (e) { toast("Passphrase passt nicht zu dieser Datei.", "err"); return; }
      zumImport = null;
      $("impPw").hidden = true;
      sicherungUebernehmen(roh);
    } finally { b.disabled = false; b.textContent = beschriftung; }
  };

  /* ---------- Altes Finanz-Dashboard (gleicher Browser / gleicher Origin) ---------- */
  async function altTresorOeffnen(o, geheim) {
    let key;
    try { key = await PfaCrypto.huelleOeffnen(o.huellen.pw, geheim); }
    catch (e) {
      if (!o.huellen.wk) throw e;
      key = await PfaCrypto.huelleOeffnen(o.huellen.wk, PfaCrypto.rkNorm(geheim));
    }
    return PfaCrypto.paketOeffnen(key, o.daten);
  }
  $("altFinanzBtn").onclick = () => {
    if (!darf()) return;
    $("altFehler").hidden = true;
    $("altPw").value = "";
    oeffne("ovlAlt");
    setTimeout(() => $("altPw").focus(), 40);
  };
  $("altPw").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("altGo").click(); } });
  $("altGo").onclick = async () => {
    if (!darf()) return;
    const o = Pfa.altFinanzTresor();
    if (!o) { $("ovlAlt").hidden = true; altBanner(); return; }
    const b = $("altGo");
    b.disabled = true;
    try {
      let roh;
      try { roh = await altTresorOeffnen(o, $("altPw").value); }
      catch (e) { $("altFehler").textContent = "Das alte Passwort passt nicht."; $("altFehler").hidden = false; return; }
      const eintraege = (Array.isArray(roh.eintraege) ? roh.eintraege : []).map(normEintrag).filter(Boolean);
      const modus = document.querySelector("input[name=altmode]:checked").value;
      // Der Hinweis ist damit in jedem Fall erledigt: Altbestand entfernen oder als uebernommen merken.
      if ($("altLoeschen").checked) Pfa.altFinanzEntfernen(); else Pfa.altFinanzErledigt(o);
      $("ovlAlt").hidden = true;
      if (!eintraege.length) { toast("Im alten Bestand stehen keine Buchungen.", "err"); altBanner(); return; }
      uebernehmen(eintraege, roh, modus);
      altBanner();
    } finally { b.disabled = false; }
  };

  /* Verwerfen: Altbestand aus dem Browser entfernen (mit Rueckfrage und Rueckgaengig), Hinweis verschwindet. */
  $("altFinanzVerwerfenBtn").onclick = () => oeffne("ovlAltVerwerfen");
  $("altVerwerfenGo").onclick = () => {
    const roh = Pfa.altFinanzEntfernen();
    $("ovlAltVerwerfen").hidden = true;
    altBanner();
    toast("Alter Bestand des Finanz-Dashboards aus diesem Browser entfernt.", "",
      { text: "Rückgängig", fn: () => { Pfa.altFinanzWiederherstellen(roh); altBanner(); } });
  };

  /* ---------- Monat kopieren ---------- */
  function fixVorbereiten() {
    const monate = [...new Set(data.eintraege.map((e) => e.datum.slice(0, 7)))].sort();
    const letzter = monate.length ? monate[monate.length - 1] : heute().slice(0, 7);
    $("fixVon").value = letzter;
    const [y, m] = letzter.split("-").map(Number);
    const n = new Date(y, m, 1);
    $("fixNach").value = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
    fixVorschau();
  }
  function fixVorschau() {
    const von = $("fixVon").value;
    const nurFix = document.querySelector("input[name=fixmode]:checked").value === "fix";
    const treffer = data.eintraege.filter((e) => e.datum.slice(0, 7) === von && (!nurFix || e.fix));
    const s = treffer.reduce((a, e) => a + (e.typ === "credit" ? e.betrag : -e.betrag), 0);
    $("fixPreview").innerHTML = treffer.length
      ? "<b>" + treffer.length + " Buchung" + (treffer.length === 1 ? "" : "en") + "</b> werden kopiert · Saldo " + fmt(s)
      : "Für diesen Monat gibt es keine passenden Buchungen" + (nurFix ? " (als 🔁 markiert)" : "") + ".";
  }
  ["fixVon", "fixNach"].forEach((id) => $(id).addEventListener("change", fixVorschau));
  document.querySelectorAll("input[name=fixmode]").forEach((r) => r.addEventListener("change", fixVorschau));
  $("fixGo").onclick = () => {
    if (!darf()) return;
    const von = $("fixVon").value;
    const nach = $("fixNach").value;
    if (!von || !nach) { toast("Bitte beide Monate wählen.", "err"); return; }
    if (von === nach) { toast("Quell- und Zielmonat sind identisch.", "err"); return; }
    const nurFix = document.querySelector("input[name=fixmode]:checked").value === "fix";
    const treffer = data.eintraege.filter((e) => e.datum.slice(0, 7) === von && (!nurFix || e.fix));
    if (!treffer.length) { toast("Nichts zu kopieren.", "err"); return; }
    const [zy, zm] = nach.split("-").map(Number);
    const letzterTag = new Date(zy, zm, 0).getDate();
    const kopien = treffer.map((e) => Object.assign({}, e, {
      id: uid(),
      datum: nach + "-" + String(Math.min(+e.datum.slice(8, 10), letzterTag)).padStart(2, "0"),
    }));
    const vorher = data.eintraege.length;
    data.eintraege = data.eintraege.concat(kopien);
    speichern();
    ui.zeit = nach; render();
    $("ovlFix").hidden = true;
    toast(kopien.length + " Buchungen nach " + monatName(nach) + " kopiert.", "",
      { text: "Rückgängig", fn: () => { data.eintraege.length = vorher; speichern(); render(); } });
  };

  document.querySelectorAll("#viewFinanz input[name=datum]").forEach((i) => i.value = heute());

  /* ---------- Modul-Schnittstelle ---------- */
  function leeren() {
    for (const id of ["listC", "listD", "catC", "catD", "chart"]) $(id).innerHTML = "";
    for (const id of ["kCredit", "kDebit", "kSaldo", "kKonto", "sumC", "sumD"]) $(id).textContent = "";
    $("fSuche").value = "";
    ui.edit = null; ui.suche = "";
  }

  function kennzahl() {
    const monat = heute().slice(0, 7);
    const im = data.eintraege.filter((e) => e.datum.slice(0, 7) === monat);
    const sc = summe(im.filter((e) => e.typ === "credit"));
    const sd = summe(im.filter((e) => e.typ === "debit"));
    const saldo = sc - sd;
    if (!data.eintraege.length) return { wert: "–", text: "Noch keine Buchungen erfasst.", klasse: "" };
    return {
      wert: (saldo > 0 ? "+" : "") + fmt(saldo),
      klasse: saldo < 0 ? "neg" : "pos",
      text: `Saldo ${monatName(monat)} · Einnahmen ${fmt(sc)} · Ausgaben ${fmt(sd)} · ${data.eintraege.length} Buchungen gesamt`,
    };
  }

  Pfa.register("finanz", {
    load(obj) {
      data = normalisieren(obj);
      ausstehend = false;
      ui.edit = null;
      // Sperren setzt alle Formulare zurueck -> Datumsfelder wieder auf heute
      document.querySelectorAll("#viewFinanz form.addform input[name=datum]").forEach((i) => { i.value = heute(); });
      if (sichtbar()) render();
    },
    daten() { return data; },
    render,
    flush,
    lock() { clearTimeout(speicherTimer); ausstehend = false; data = leer(); leeren(); },
    adminChanged() { if (sichtbar()) render(); },
    kennzahl,
  });

  return { render, get data() { return data; } };
})();
