/*
 * PFA – Bereich Honorare (Rechnungen aus Gutachten)
 * Ampel offen / verschickt / bezahlt, Mahnstufen 1–3, Debitoren, PDFs im Vault.
 * Speicherung: verschluesselt im Repository ueber Pfa.speichern("honorar", …),
 * PDFs ueber Pfa.pdfSchreiben / pdfLesen / pdfLoeschen.
 */
"use strict";

const Honorar = (() => {
  const { $, toast, busy, esc, fmtDate, todayIso, fmtEUR } = Pfa;

  const STATUS = {
    offen:      { label: "Offen – nicht bezahlt",           farbe: "rot",   emoji: "🔴" },
    verschickt: { label: "Verschickt – wartet auf Zahlung", farbe: "gelb",  emoji: "🟡" },
    bezahlt:    { label: "Bezahlt",                         farbe: "gruen", emoji: "🟢" },
  };

  const leer = () => ({ version: 1, debtors: ["LaLux"], invoices: [] });

  const state = {
    data: leer(),
    filters: { status: "alle", debtor: "alle", year: "alle", q: "" },
    editingId: null,
    pendingDraftId: null,
    opBusy: false,
    get admin() { return Pfa.state.admin; },
  };
  const sichtbar = () => Pfa.state.view === "honorar";

  function snapshotData() { return JSON.stringify(state.data); }
  function restoreData(snap) { state.data = normalizeData(JSON.parse(snap)); }

  function normalizeData(data) {
    if (!data || typeof data !== "object") data = leer();
    data.version = data.version || 1;
    data.debtors = Array.isArray(data.debtors) && data.debtors.length ? data.debtors : ["LaLux"];
    data.invoices = Array.isArray(data.invoices) ? data.invoices : [];
    for (const inv of data.invoices) {
      if (!inv.id) inv.id = crypto.randomUUID();
      if (!STATUS[inv.status]) inv.status = "offen";
      inv.amount = Number(inv.amount) || 0;
      if (typeof inv.mahnungen !== "object" || inv.mahnungen === null || Array.isArray(inv.mahnungen)) inv.mahnungen = {};
      for (const k of Object.keys(inv.mahnungen)) {
        if (!["1", "2", "3"].includes(k) || typeof inv.mahnungen[k] !== "string") delete inv.mahnungen[k];
      }
    }
    return data;
  }

  function mahnstufe(inv) {
    for (const s of [3, 2, 1]) if (inv.mahnungen && inv.mahnungen[String(s)]) return s;
    return 0;
  }

  const saveData = (message) => Pfa.speichern("honorar", state.data, message || "Update honorar");

  /* ================= Darstellung ================= */

  function invoiceYears() {
    const years = new Set();
    for (const inv of state.data.invoices) if (inv.date) years.add(inv.date.slice(0, 4));
    return [...years].sort().reverse();
  }

  function baseFiltered() {
    const q = state.filters.q.trim().toLowerCase();
    return state.data.invoices.filter((inv) => {
      if (state.filters.debtor !== "alle" && inv.debtor !== state.filters.debtor) return false;
      if (state.filters.year !== "alle" && (inv.date || "").slice(0, 4) !== state.filters.year) return false;
      if (q) {
        const hay = `${inv.number} ${inv.name} ${inv.debtor} ${inv.notes || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function isOverdue(inv) {
    return inv.status !== "bezahlt" && inv.dueDate && inv.dueDate < todayIso();
  }

  function render() {
    if (!state.data) return;
    $("adminBar").hidden = !state.admin.active;
    renderSummary();
    renderFilters();
    renderList();
  }

  function renderSummary() {
    const base = baseFiltered();
    const cards = [["alle", "Gesamt", "∑"]].concat(Object.entries(STATUS).map(([key, s]) => [key, s.label, s.emoji]));
    const wrap = $("summaryCards");
    wrap.replaceChildren();
    for (const [key, label, icon] of cards) {
      const items = key === "alle" ? base : base.filter((i) => i.status === key);
      const sum = items.reduce((n, i) => n + i.amount, 0);
      const card = document.createElement("div");
      const farbe = key === "alle" ? "alle" : STATUS[key].farbe;
      card.className = `sum-card ${farbe}` + (state.filters.status === key ? " active" : "");
      card.innerHTML = `
        <div class="sum-label"><span>${icon}</span> ${esc(label)}</div>
        <div class="sum-amount">${fmtEUR.format(sum)}</div>
        <div class="sum-count">${items.length} Rechnung${items.length === 1 ? "" : "en"}</div>`;
      card.addEventListener("click", () => { state.filters.status = key; render(); });
      wrap.appendChild(card);
    }
  }

  function fillSelect(sel, options, current) {
    sel.replaceChildren();
    for (const [value, label] of options) {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      if (value === current) o.selected = true;
      sel.appendChild(o);
    }
  }

  function renderFilters() {
    if (state.filters.debtor !== "alle" && !state.data.debtors.includes(state.filters.debtor)) state.filters.debtor = "alle";
    const years = invoiceYears();
    if (state.filters.year !== "alle" && !years.includes(state.filters.year)) state.filters.year = "alle";
    fillSelect($("debtorFilter"), [["alle", "Alle Debitoren"]].concat(state.data.debtors.map((d) => [d, d])), state.filters.debtor);
    const proJahr = (y) => state.data.invoices.filter((i) => (i.date || "").slice(0, 4) === y).length;
    fillSelect($("yearFilter"),
      [["alle", `Alle Jahre (${state.data.invoices.length})`]].concat(years.map((y) => [y, `${y} (${proJahr(y)})`])),
      state.filters.year);
  }

  function sortedInvoices(list) {
    return [...list].sort((a, b) => {
      const da = a.date || "0000", db = b.date || "0000";
      if (da !== db) return db.localeCompare(da);
      return String(b.number).localeCompare(String(a.number));
    });
  }

  function renderList() {
    const list = sortedInvoices(baseFiltered().filter((i) => state.filters.status === "alle" || i.status === state.filters.status));
    const wrap = $("invoiceList");
    wrap.replaceChildren();
    $("emptyHint").hidden = list.length > 0;

    for (const inv of list) {
      const s = STATUS[inv.status];
      const card = document.createElement("article");
      card.className = "inv-card";
      const metaParts = [
        `<span class="inv-number">${esc(inv.number)}</span>`,
        `<span class="debtor-chip">${esc(inv.debtor)}</span>`,
      ];
      if (inv.date) metaParts.push(`<span>Rechnung: ${fmtDate(inv.date)}</span>`);
      if (inv.dueDate && inv.status !== "bezahlt")
        metaParts.push(`<span class="${isOverdue(inv) ? "overdue" : ""}">fällig: ${fmtDate(inv.dueDate)}${isOverdue(inv) ? " – ÜBERFÄLLIG" : ""}</span>`);
      if (inv.status === "bezahlt" && inv.paidDate) metaParts.push(`<span>bezahlt am ${fmtDate(inv.paidDate)}</span>`);
      for (const st of [1, 2, 3]) {
        const d = inv.mahnungen && inv.mahnungen[String(st)];
        if (d) metaParts.push(`<span class="mahn-chip stufe${st}${inv.status === "bezahlt" ? " erledigt" : ""}" title="${st}. Mahnung verschickt am ${fmtDate(d)}">⚠️ ${st}. Mahnung: ${fmtDate(d)}</span>`);
      }
      card.innerHTML = `
        <div class="ampel ${s.farbe}" title="${esc(s.label)}"></div>
        <div class="inv-main">
          <div class="inv-name">${esc(inv.name)}</div>
          <div class="inv-meta">${metaParts.join("")}</div>
        </div>
        <div class="inv-right">
          <div class="inv-amount">${fmtEUR.format(inv.amount)}</div>
          <span class="status-badge ${s.farbe}">${s.emoji} ${esc(s.label)}</span>
        </div>`;

      const actions = document.createElement("div");
      actions.className = "inv-actions";
      if (inv.pdf && inv.pdf.type === "vault") {
        const viewBtn = document.createElement("button");
        viewBtn.className = "btn"; viewBtn.textContent = "📄 PDF ansehen";
        viewBtn.addEventListener("click", () => viewVaultPdf(inv));
        actions.appendChild(viewBtn);
      } else if (inv.pdf && inv.pdf.type === "link" && /^https?:\/\//i.test(inv.pdf.url)) {
        const linkBtn = document.createElement("a");
        linkBtn.className = "btn"; linkBtn.textContent = "🔗 PDF öffnen (extern)";
        linkBtn.href = inv.pdf.url; linkBtn.target = "_blank"; linkBtn.rel = "noopener noreferrer";
        actions.appendChild(linkBtn);
      }

      if (state.admin.active) {
        const statusSel = document.createElement("select");
        fillSelect(statusSel, Object.entries(STATUS).map(([k, v]) => [k, `${v.emoji} ${v.label}`]), inv.status);
        statusSel.title = "Status ändern";
        statusSel.addEventListener("change", () => changeStatus(inv, statusSel.value));
        actions.appendChild(statusSel);

        const hoechste = mahnstufe(inv);
        if (!inv.mahnungen) inv.mahnungen = {};
        for (const st of inv.status === "bezahlt" ? [] : [1, 2, 3]) {
          const gesetzt = inv.mahnungen[String(st)];
          const btn = document.createElement("button");
          btn.className = "btn mahn-btn" + (gesetzt ? " gesetzt" : "");
          if (gesetzt) {
            btn.textContent = `✓ ${st}. Mahnung`;
            if (st === hoechste) {
              btn.title = `Verschickt am ${fmtDate(gesetzt)} – Klick entfernt diese Mahnstufe`;
              btn.addEventListener("click", () => removeMahnung(inv, st));
            } else { btn.title = `Verschickt am ${fmtDate(gesetzt)}`; btn.disabled = true; }
          } else if (st === hoechste + 1) {
            btn.textContent = `＋ ${st}. Mahnung`;
            btn.title = `${st}. Mahnung als heute verschickt markieren`;
            btn.addEventListener("click", () => setMahnung(inv, st));
          } else {
            btn.textContent = `${st}. Mahnung`;
            btn.title = `Erst die ${st - 1}. Mahnung setzen`;
            btn.disabled = true;
          }
          actions.appendChild(btn);
        }

        const editBtn = document.createElement("button");
        editBtn.className = "btn"; editBtn.textContent = "✏️ Bearbeiten";
        editBtn.addEventListener("click", () => openInvoiceDialog(inv));
        actions.appendChild(editBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "btn danger"; delBtn.textContent = "🗑️ Löschen";
        delBtn.addEventListener("click", () => deleteInvoice(inv));
        actions.appendChild(delBtn);
      }

      if (actions.childElementCount) card.appendChild(actions);
      if (inv.notes) {
        const n = document.createElement("div");
        n.className = "inv-notes"; n.textContent = `Notiz: ${inv.notes}`;
        card.appendChild(n);
      }
      wrap.appendChild(card);
    }

    const all = state.data.invoices;
    const open = all.filter((i) => i.status !== "bezahlt").reduce((n, i) => n + i.amount, 0);
    $("footerStats").textContent = `${all.length} Rechnungen insgesamt · noch unbezahlt (🔴+🟡): ${fmtEUR.format(open)}`;
  }

  /* ================= PDF anzeigen ================= */

  async function viewVaultPdf(inv) {
    try {
      busy("PDF wird entschlüsselt …");
      const plain = await Pfa.pdfLesen(inv.pdf.file);
      const url = Pfa.blobUrl(new Blob([plain], { type: "application/pdf" }));
      $("pdfTitle").textContent = `${inv.number} – ${inv.name}`;
      $("pdfFrame").src = url;
      const dl = $("pdfDownload");
      dl.href = url;
      dl.download = `${inv.number}.pdf`.replace(/[^\w.\-]+/g, "_");
      $("pdfNewTab").href = url;
      $("pdfDialog").showModal();
    } catch (e) {
      toast(`Fehler: ${e.message}`, "err");
    } finally {
      busy(false);
    }
  }

  /* ================= Aenderungen ================= */

  async function lauf(arbeitstext, mutation, erfolg, meldungFehler) {
    if (state.opBusy) return;
    if (!Pfa.requireAdmin()) return;
    state.opBusy = true;
    const snap = snapshotData();
    try {
      busy(arbeitstext);
      await mutation();
      if (erfolg) erfolg();
    } catch (e) {
      if (!e.vaultReloaded) restoreData(snap);
      toast(`${meldungFehler || "Speichern fehlgeschlagen"}: ${e.message}`, "err", 7000);
    } finally {
      state.opBusy = false;
      busy(false);
      render();
    }
  }

  function changeStatus(inv, newStatus) {
    lauf("Status wird gespeichert …", async () => {
      inv.status = newStatus;
      if (newStatus === "bezahlt" && !inv.paidDate) inv.paidDate = todayIso();
      if (newStatus !== "bezahlt") delete inv.paidDate;
      await saveData("Update honorar");
    }, () => toast(`Status geändert: ${STATUS[newStatus].emoji} ${STATUS[newStatus].label}`));
  }

  function setMahnung(inv, stufe) {
    lauf("Mahnstufe wird gespeichert …", async () => {
      inv.mahnungen[String(stufe)] = todayIso();
      await saveData("Update honorar");
    }, () => toast(`⚠️ ${stufe}. Mahnung als verschickt markiert (${fmtDate(inv.mahnungen[String(stufe)])}).`));
  }

  function removeMahnung(inv, stufe) {
    if (!confirm(`${stufe}. Mahnung (verschickt am ${fmtDate(inv.mahnungen[String(stufe)])}) wirklich entfernen?`)) return;
    lauf("Mahnstufe wird entfernt …", async () => {
      delete inv.mahnungen[String(stufe)];
      await saveData("Update honorar");
    }, () => toast(`${stufe}. Mahnung entfernt.`));
  }

  function deleteInvoice(inv) {
    if (!confirm(`Rechnung ${inv.number} („${inv.name}“) wirklich löschen?`)) return;
    let warn = "";
    lauf("Rechnung wird gelöscht …", async () => {
      state.data.invoices = state.data.invoices.filter((i) => i.id !== inv.id);
      await saveData("Update honorar");
      if (inv.pdf && inv.pdf.type === "vault") {
        try { await Pfa.pdfLoeschen(inv.pdf.file, "Remove encrypted invoice PDF"); }
        catch { warn = " Hinweis: Die verschlüsselte PDF-Datei konnte nicht entfernt werden (unkritisch, Datei ist verwaist)."; }
      }
    }, () => toast("Rechnung gelöscht." + warn, warn ? 6000 : 3500), "Löschen fehlgeschlagen");
  }

  /* ================= Rechnungs-Formular ================= */

  function openInvoiceDialog(inv) {
    state.editingId = inv ? inv.id : null;
    state.pendingDraftId = null;
    const form = $("invoiceForm");
    form.reset();
    $("pdfRemoveWrap").hidden = !(inv && inv.pdf);
    $("invoiceFormTitle").textContent = inv ? `Rechnung bearbeiten – ${inv.number}` : "Neue Rechnung";
    fillSelect($("debtorSelect"),
      state.data.debtors.map((d) => [d, d]).concat([["__neu__", "＋ Neuer Debitor …"]]),
      inv ? inv.debtor : state.data.debtors[0]);
    $("newDebtorWrap").hidden = true;
    if (inv) {
      form.number.value = inv.number || "";
      form.name.value = inv.name || "";
      form.amount.value = inv.amount;
      form.status.value = inv.status;
      form.date.value = inv.date || "";
      form.dueDate.value = inv.dueDate || "";
      form.notes.value = inv.notes || "";
      if (inv.pdf && inv.pdf.type === "vault") $("pdfKeepLabel").textContent = "Vorhandenes PDF behalten";
      else if (inv.pdf && inv.pdf.type === "link") { $("pdfKeepLabel").textContent = "Vorhandenen Link behalten"; form.pdfUrl.value = inv.pdf.url; }
      else $("pdfKeepLabel").textContent = "Ohne PDF";
    } else {
      $("pdfKeepLabel").textContent = "Ohne PDF";
      form.date.value = todayIso();
    }
    form.pdfFile.hidden = true;
    form.pdfUrl.hidden = true;
    $("invoiceDialog").showModal();
  }

  async function submitInvoiceForm(form) {
    if (state.opBusy) return;
    if (!Pfa.requireAdmin()) return;
    const editing = state.editingId ? state.data.invoices.find((i) => i.id === state.editingId) : null;

    let debtor = form.debtor.value;
    let newDebtorName = null;
    if (debtor === "__neu__") {
      debtor = form.newDebtor.value.trim();
      if (!debtor) { toast("Bitte Namen des neuen Debitors angeben.", "err"); return; }
      newDebtorName = debtor;
    }

    const draft = editing ? { ...editing } : { id: state.pendingDraftId || crypto.randomUUID(), currency: "EUR", mahnungen: {} };
    draft.number = form.number.value.trim();
    draft.name = form.name.value.trim();
    draft.amount = Math.round(parseFloat(form.amount.value) * 100) / 100;
    draft.debtor = debtor;
    draft.status = form.status.value;
    draft.date = form.date.value || "";
    draft.dueDate = form.dueDate.value || "";
    draft.notes = form.notes.value.trim();
    if (draft.status === "bezahlt" && !draft.paidDate) draft.paidDate = todayIso();
    if (draft.status !== "bezahlt") delete draft.paidDate;

    const source = form.pdfSource.value;
    const oldVaultFile = editing && editing.pdf && editing.pdf.type === "vault" ? editing.pdf.file : null;

    let pdfFile = null;
    if (source === "vault") {
      pdfFile = form.pdfFile.files[0];
      if (!pdfFile) { toast("Bitte eine PDF-Datei auswählen.", "err"); return; }
      if (pdfFile.size > 25 * 1024 * 1024) { toast("PDF größer als 25 MB – bitte verkleinern.", "err"); return; }
    }
    if (source === "link") {
      const url = form.pdfUrl.value.trim();
      if (!/^https?:\/\//i.test(url)) { toast("Bitte einen gültigen https-Link angeben.", "err"); return; }
      draft.pdf = { type: "link", url };
    }
    if (source === "none") delete draft.pdf;

    state.opBusy = true;
    const snap = snapshotData();
    try {
      busy("Wird gespeichert …");
      if (source === "vault") {
        busy("PDF wird verschlüsselt und hochgeladen …");
        const plain = new Uint8Array(await pdfFile.arrayBuffer());
        const fileName = `${draft.id}.enc`;
        await Pfa.pdfSchreiben(fileName, plain, "Add encrypted invoice PDF");
        draft.pdf = { type: "vault", file: fileName };
      }
      busy("Rechnungsdaten werden gespeichert …");
      if (newDebtorName && !state.data.debtors.includes(newDebtorName)) state.data.debtors.push(newDebtorName);
      if (editing) state.data.invoices = state.data.invoices.map((i) => (i.id === draft.id ? draft : i));
      else state.data.invoices.push(draft);
      await saveData("Update honorar");
      state.pendingDraftId = null;

      let warn = "";
      if (oldVaultFile && !(draft.pdf && draft.pdf.type === "vault" && draft.pdf.file === oldVaultFile)) {
        try { await Pfa.pdfLoeschen(oldVaultFile, "Remove replaced invoice PDF"); }
        catch { warn = " Hinweis: Das alte PDF konnte nicht entfernt werden (unkritisch)."; }
      }
      $("invoiceDialog").close();
      toast("Gespeichert." + warn, warn ? 6000 : 3500);
    } catch (e) {
      if (!e.vaultReloaded) restoreData(snap);
      if (!editing) state.pendingDraftId = draft.id;
      toast(`Speichern fehlgeschlagen: ${e.message}`, "err", 7000);
    } finally {
      state.opBusy = false;
      busy(false);
      render();
    }
  }

  /* ================= Zurücksetzen ================= */

  function resetBetroffen() {
    const umfang = document.querySelector("#resetForm input[name=rscope]:checked").value;
    if (umfang !== "jahr") return state.data.invoices.slice();
    const jahr = $("resetYear").value;
    return state.data.invoices.filter((i) => (i.date || "").slice(0, 4) === jahr);
  }
  function resetBestaetigt() {
    const t = $("resetConfirm").value.trim().toUpperCase().replace(/\s+/g, "");
    return t === "LÖSCHEN" || t === "LOESCHEN" || t === "DELETE";
  }
  function resetKnopfPruefen() {
    const bereit = resetBestaetigt() && resetBetroffen().length > 0;
    $("resetGoBtn").classList.toggle("wartet", !bereit);
    $("resetHint").textContent = resetBetroffen().length === 0 ? "" : bereit ? "" : "Der Knopf wird scharf, sobald hier LÖSCHEN steht.";
  }
  function resetVorschau() {
    const umfang = document.querySelector("#resetForm input[name=rscope]:checked").value;
    const liste = resetBetroffen();
    const summe = liste.reduce((n, i) => n + (Number(i.amount) || 0), 0);
    const mitPdf = liste.filter((i) => i.pdf && i.pdf.type === "vault").length;
    const box = $("resetPreview");
    box.classList.toggle("ernst", liste.length > 0);
    box.innerHTML = liste.length
      ? `<b>${liste.length} Rechnung(en)</b> über <b>${fmtEUR.format(summe)}</b> werden gelöscht` +
        (mitPdf && $("resetPdfs").checked ? `, dazu ${mitPdf} verschlüsselte PDF-Datei(en)` : "") + ". Rückgängig geht das hier nicht."
      : "Für diese Auswahl gibt es nichts zu löschen.";
    $("resetYear").disabled = umfang !== "jahr";
    $("resetDebtorsWrap").hidden = umfang !== "alle";
    resetKnopfPruefen();
  }
  async function zuruecksetzen() {
    if (state.opBusy) return;
    const errEl = $("resetError");
    errEl.hidden = true;
    const fehler = (text) => { errEl.textContent = text; errEl.hidden = false; };
    if (!resetBestaetigt()) { fehler("Bitte zur Bestätigung LÖSCHEN in das Feld eintippen."); $("resetConfirm").focus(); return; }
    if (!resetBetroffen().length) { fehler("Für diese Auswahl gibt es nichts zu löschen."); return; }
    if (!state.admin.active) { fehler("Bitte zuerst die Verwaltung aktivieren – ohne GitHub-Token lässt sich im Vault nichts löschen."); return; }
    const liste = resetBetroffen();
    const pdfsAuch = $("resetPdfs").checked;
    const debitorenAuch = $("resetDebtors").checked && document.querySelector("#resetForm input[name=rscope]:checked").value === "alle";
    const ids = new Set(liste.map((i) => i.id));
    state.opBusy = true;
    const snap = snapshotData();
    try {
      busy("Daten werden zurückgesetzt …");
      state.data.invoices = state.data.invoices.filter((i) => !ids.has(i.id));
      if (debitorenAuch) state.data.debtors = ["LaLux"];
      await saveData(`Reset: ${liste.length} Rechnung(en) entfernt`);
      let verwaist = 0;
      if (pdfsAuch) {
        const mitPdf = liste.filter((i) => i.pdf && i.pdf.type === "vault");
        let n = 0;
        for (const inv of mitPdf) {
          busy(`PDF ${++n} von ${mitPdf.length} wird entfernt …`);
          try { await Pfa.pdfLoeschen(inv.pdf.file, "Remove encrypted invoice PDF"); } catch { verwaist++; }
        }
      }
      $("resetDialog").close();
      toast(`${liste.length} Rechnung(en) gelöscht.` + (verwaist ? ` ${verwaist} PDF-Datei(en) blieben verwaist (unkritisch).` : ""), 7000);
    } catch (e) {
      if (!e.vaultReloaded) restoreData(snap);
      fehler(`Zurücksetzen fehlgeschlagen: ${e.message}`);
    } finally {
      state.opBusy = false;
      busy(false);
      render();
    }
  }

  /* ================= Ereignisbindung ================= */

  document.addEventListener("DOMContentLoaded", () => {
    $("pdfDialog").addEventListener("close", () => {
      $("pdfFrame").src = "about:blank";
      $("pdfTitle").textContent = "";
      $("pdfDownload").removeAttribute("href");
      $("pdfDownload").removeAttribute("download");
      $("pdfNewTab").removeAttribute("href");
    });

    $("searchInput").addEventListener("input", (e) => { state.filters.q = e.target.value; render(); });
    $("debtorFilter").addEventListener("change", (e) => { state.filters.debtor = e.target.value; render(); });
    $("yearFilter").addEventListener("change", (e) => { state.filters.year = e.target.value; render(); });

    $("newInvoiceBtn").addEventListener("click", () => openInvoiceDialog(null));
    const invForm = $("invoiceForm");
    invForm.addEventListener("submit", (e) => { e.preventDefault(); submitInvoiceForm(invForm); });
    invForm.debtor.addEventListener("change", () => { $("newDebtorWrap").hidden = invForm.debtor.value !== "__neu__"; });
    for (const radio of invForm.querySelectorAll('input[name="pdfSource"]')) {
      radio.addEventListener("change", () => {
        invForm.pdfFile.hidden = invForm.pdfSource.value !== "vault";
        invForm.pdfUrl.hidden = invForm.pdfSource.value !== "link";
      });
    }

    // Zuruecksetzen
    $("resetBtn").addEventListener("click", () => {
      $("resetError").hidden = true;
      $("resetConfirm").value = "";
      $("resetForm").querySelector("input[name=rscope][value=alle]").checked = true;
      $("resetPdfs").checked = true;
      $("resetDebtors").checked = false;
      const jahre = invoiceYears();
      fillSelect($("resetYear"), jahre.map((y) => [y, y]), jahre[0]);
      resetVorschau();
      $("resetDialog").showModal();
    });
    for (const id of ["resetPdfs", "resetDebtors", "resetYear"]) $(id).addEventListener("change", resetVorschau);
    for (const r of document.querySelectorAll("#resetForm input[name=rscope]")) r.addEventListener("change", resetVorschau);
    $("resetConfirm").addEventListener("input", resetKnopfPruefen);
    $("resetGoBtn").addEventListener("click", zuruecksetzen);
    $("resetForm").addEventListener("submit", (e) => { e.preventDefault(); zuruecksetzen(); });

    // Debitoren
    $("adminSettingsBtn").addEventListener("click", () => {
      $("settingsForm").addDebtor.value = "";
      $("debtorListe").textContent = "Vorhandene Debitoren: " + state.data.debtors.join(", ");
      $("settingsDialog").showModal();
    });
    $("settingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nd = e.target.addDebtor.value.trim();
      $("settingsDialog").close();
      if (!nd) return;
      if (state.data.debtors.includes(nd)) { toast(`Debitor „${nd}“ gibt es schon.`); return; }
      lauf("Debitor wird gespeichert …", async () => {
        state.data.debtors.push(nd);
        await saveData("Update honorar");
      }, () => toast(`Debitor „${nd}“ hinzugefügt.`));
    });
  });

  /* ================= Modul-Schnittstelle ================= */

  function leeren() {
    $("invoiceList").replaceChildren();
    $("summaryCards").replaceChildren();
    $("debtorFilter").replaceChildren();
    $("yearFilter").replaceChildren();
    $("searchInput").value = "";
    $("footerStats").textContent = "";
    $("pdfTitle").textContent = "";
    $("pdfFrame").src = "about:blank";
    $("pdfDownload").removeAttribute("href");
    $("pdfNewTab").removeAttribute("href");
    $("emptyHint").hidden = true;
    $("adminBar").hidden = true;
    $("importBanner").hidden = true;
    $("importBannerText").textContent = "";
    if (typeof Reports !== "undefined" && Reports.berichtLeeren) Reports.berichtLeeren();
  }

  function kennzahl() {
    const all = state.data.invoices;
    if (!all.length) return { wert: "–", text: "Noch keine Rechnungen erfasst.", klasse: "" };
    const offen = all.filter((i) => i.status !== "bezahlt");
    const summe = offen.reduce((n, i) => n + i.amount, 0);
    const ueber = offen.filter(isOverdue).length;
    const mahn = offen.filter((i) => mahnstufe(i) > 0).length;
    return {
      wert: fmtEUR.format(summe),
      klasse: ueber ? "neg" : offen.length ? "warn" : "pos",
      text: offen.length
        ? `noch offen aus ${offen.length} Rechnung${offen.length === 1 ? "" : "en"}` +
          (ueber ? ` · ${ueber} überfällig` : "") + (mahn ? ` · ${mahn} gemahnt` : "") + ` · ${all.length} gesamt`
        : `alles bezahlt · ${all.length} Rechnung${all.length === 1 ? "" : "en"} gesamt`,
    };
  }

  Pfa.register("honorar", {
    load(obj) {
      state.data = normalizeData(obj || leer());
      state.editingId = null;
      state.pendingDraftId = null;
      if (sichtbar()) render();
    },
    daten() { return state.data; },
    render,
    flush() { return Promise.resolve(); },
    lock() {
      state.data = leer();
      state.filters = { status: "alle", debtor: "alle", year: "alle", q: "" };
      state.editingId = null; state.pendingDraftId = null;
      leeren();
    },
    adminChanged() { if (sichtbar()) render(); },
    kennzahl,
  });

  return { state, STATUS, baseFiltered, sortedInvoices, normalizeData, isOverdue, mahnstufe,
    saveData, snapshotData, restoreData, render, fillSelect };
})();
