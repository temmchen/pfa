/*
 * PFA – Export & Import fuer den Bereich Honorare
 * ------------------------------------------------
 * Vier Ausgabeformate, alle ohne fremde Bibliotheken:
 *   - Verschluesselte Sicherung (.json, Format "pfa-sicherung": oeffnet sich mit
 *     Passphrase oder Wiederherstellungsschluessel, optional samt aller
 *     Rechnungs-PDFs) -> der vollstaendige Offline-Rueckhalt
 *   - Excel (.xlsx) -> echte Arbeitsmappe, hier von Hand erzeugt
 *     (ZIP mit STORED-Eintraegen + OOXML), Betraege und Daten als Zahlen
 *   - PDF ueber einen eigenen Druckbericht ("Als PDF sichern" im Druckdialog)
 *   - Klartext JSON und CSV
 * Import versteht PFA-Sicherungen (.json), alte Honorar-Sicherungen (.enc, TBV1),
 * Klartext-JSON und CSV. Ohne Verwaltung wird nur die Ansicht befuellt (klar
 * gekennzeichnet), mit Verwaltung in den Vault gespeichert.
 */
"use strict";

const Reports = (() => {
  const { $, toast, busy, esc, fmtDate, fmtEUR } = Pfa;
  const { state, STATUS, baseFiltered, sortedInvoices, normalizeData, isOverdue, mahnstufe,
    saveData, snapshotData, restoreData, render } = Honorar;
  const b64encode = PfaCrypto.b64;
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  /* ================= Datei speichern ================= */

  let pickerNutzbar = typeof window.showSaveFilePicker === "function";

  async function speichern(name, daten, mime, beschreibung, endung) {
    const blob = daten instanceof Blob ? daten : new Blob([daten], { type: mime + ";charset=utf-8" });
    if (pickerNutzbar) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: beschreibung, accept: { [mime]: [endung] } }],
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return handle.name;
      } catch (err) {
        if (err && err.name === "AbortError") return null;
        pickerNutzbar = false; // z. B. blockiert -> klassischer Download
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return name;
  }

  const stempel = () => new Date().toISOString().slice(0, 10);
  const dateiName = (endung) => `honorare-${stempel()}${endung}`;

  /* ================= Auswahl ================= */

  /** Welche Rechnungen exportiert werden: ganze Kartei oder aktuelle Filter. */
  function auswahl(umfang) {
    if (!state.data) return [];
    const liste =
      umfang === "filter"
        ? baseFiltered().filter(
            (i) => state.filters.status === "alle" || i.status === state.filters.status
          )
        : state.data.invoices;
    return sortedInvoices(liste);
  }

  function auswahlText(umfang) {
    if (umfang !== "filter") return "alle Rechnungen";
    const t = [];
    if (state.filters.status !== "alle") t.push(STATUS[state.filters.status].label);
    if (state.filters.debtor !== "alle") t.push(`Debitor ${state.filters.debtor}`);
    if (state.filters.year !== "alle") t.push(`Jahr ${state.filters.year}`);
    if (state.filters.q.trim()) t.push(`Suche „${state.filters.q.trim()}“`);
    return t.length ? t.join(" · ") : "alle Rechnungen";
  }

  const summe = (liste) => liste.reduce((n, i) => n + (Number(i.amount) || 0), 0);

  /* ================= Verschluesselte Sicherung ================= */

  /** Holt ein Vault-PDF entschluesselt ueber den Kern (API im Verwaltungsmodus, sonst Seite). */
  const pdfBytes = (inv) => Pfa.pdfLesen(inv.pdf.file);

  async function exportSicherung(umfang, mitPdfs, eigenePass) {
    const liste = auswahl(umfang);
    const paket = {
      format: "honorar-sicherung",
      version: 1,
      erstellt: new Date().toISOString(),
      umfang: auswahlText(umfang),
      debtors: state.data.debtors,
      invoices: liste,
      pdfs: {},
    };
    if (mitPdfs) {
      const mitVault = liste.filter((i) => i.pdf && i.pdf.type === "vault");
      let n = 0;
      const fehlend = [];
      for (const inv of mitVault) {
        busy(`PDF ${++n} von ${mitVault.length} wird gesichert …`);
        try {
          paket.pdfs[inv.id] = b64encode(await pdfBytes(inv));
        } catch (e) {
          fehlend.push(inv.number);
        }
      }
      if (fehlend.length) paket.pdfsFehlend = fehlend;
    }
    busy("Sicherung wird verschlüsselt …");
    /* Ohne eigene Passphrase traegt die Datei die Huellen des Schluesselbunds und
       oeffnet sich mit Passphrase oder Wiederherstellungsschluessel; mit eigener
       Passphrase bekommt sie einen frischen Sicherungsschluessel. */
    const text = await Pfa.sicherungBauen("honorar", paket, eigenePass);
    const name = await speichern(
      `honorare-sicherung-${stempel()}.json`, text, "application/json", "Verschlüsselte Sicherung", ".json"
    );
    const fehlt = paket.pdfsFehlend ? ` ${paket.pdfsFehlend.length} PDF(s) waren nicht erreichbar.` : "";
    const schutz = eigenePass ? " Geschützt mit der eigenen Passphrase – bitte getrennt aufbewahren!" : " Öffnet sich mit der PFA-Passphrase oder dem Wiederherstellungsschlüssel.";
    return name && `${liste.length} Rechnungen${mitPdfs ? ` und ${Object.keys(paket.pdfs).length} PDFs` : ""} gesichert als „${name}“.${fehlt}${schutz}`;
  }

  /* ================= JSON / CSV ================= */

  async function exportJson(umfang) {
    const inhalt = JSON.stringify(
      { format: "honorar-klartext", version: 1, erstellt: new Date().toISOString(),
        umfang: auswahlText(umfang), debtors: state.data.debtors, invoices: auswahl(umfang) },
      null, 2
    );
    const name = await speichern(dateiName(".json"), inhalt, "application/json", "JSON-Datei", ".json");
    return name && `Als „${name}“ gespeichert (Klartext!).`;
  }

  const csvFeld = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const SPALTEN = [
    ["Nummer",         (i) => i.number],
    ["Bezeichnung",    (i) => i.name],
    ["Debitor",        (i) => i.debtor],
    ["Status",         (i) => (STATUS[i.status] || {}).label || i.status],
    ["Betrag",         (i) => i.amount],
    ["Rechnungsdatum", (i) => i.date || ""],
    ["Fällig bis",     (i) => i.dueDate || ""],
    ["Bezahlt am",     (i) => i.paidDate || ""],
    ["Überfällig",     (i) => (isOverdue(i) ? "ja" : "")],
    ["Mahnstufe",      (i) => mahnstufe(i) || ""],
    ["1. Mahnung",     (i) => (i.mahnungen && i.mahnungen["1"]) || ""],
    ["2. Mahnung",     (i) => (i.mahnungen && i.mahnungen["2"]) || ""],
    ["3. Mahnung",     (i) => (i.mahnungen && i.mahnungen["3"]) || ""],
    ["Beleg",          (i) => (!i.pdf ? "" : i.pdf.type === "link" ? i.pdf.url : "PDF im Vault")],
    ["Notiz",          (i) => i.notes || ""],
  ];

  async function exportCsv(umfang) {
    const liste = auswahl(umfang);
    const zeilen = [SPALTEN.map((s) => s[0]).join(";")];
    for (const inv of liste) {
      zeilen.push(SPALTEN.map(([, f]) => {
        const v = f(inv);
        return csvFeld(typeof v === "number" ? String(v).replace(".", ",") : v);
      }).join(";"));
    }
    const inhalt = "﻿" + zeilen.join("\r\n") + "\r\n";   // BOM: Excel erkennt UTF-8
    const name = await speichern(dateiName(".csv"), inhalt, "text/csv", "CSV-Tabelle", ".csv");
    return name && `Als „${name}“ gespeichert (Klartext!).`;
  }

  /* ================= Excel (.xlsx) ================= */

  const crcTab = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTab[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Minimales ZIP (Methode 0 = unkomprimiert) – genau das, was .xlsx braucht. */
  function zip(dateien) {
    const teile = [], zentral = [];
    let offset = 0;
    const j = new Date();
    const zeit = ((j.getHours() << 11) | (j.getMinutes() << 5) | (j.getSeconds() >> 1)) & 0xffff;
    const datum = (((j.getFullYear() - 1980) << 9) | ((j.getMonth() + 1) << 5) | j.getDate()) & 0xffff;

    for (const d of dateien) {
      const name = new TextEncoder().encode(d.name);
      const crc = crc32(d.bytes), len = d.bytes.length;

      const lokal = new Uint8Array(30 + name.length);
      const lv = new DataView(lokal.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);            // Version
      lv.setUint16(6, 0, true);             // Flags
      lv.setUint16(8, 0, true);             // Methode: stored
      lv.setUint16(10, zeit, true); lv.setUint16(12, datum, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, len, true); lv.setUint32(22, len, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      lokal.set(name, 30);
      teile.push(lokal, d.bytes);

      const z = new Uint8Array(46 + name.length);
      const zv = new DataView(z.buffer);
      zv.setUint32(0, 0x02014b50, true);
      zv.setUint16(4, 20, true); zv.setUint16(6, 20, true);
      zv.setUint16(8, 0, true); zv.setUint16(10, 0, true);
      zv.setUint16(12, zeit, true); zv.setUint16(14, datum, true);
      zv.setUint32(16, crc, true);
      zv.setUint32(20, len, true); zv.setUint32(24, len, true);
      zv.setUint16(28, name.length, true);
      zv.setUint32(38, 0, true);            // externe Attribute
      zv.setUint32(42, offset, true);       // Offset des lokalen Kopfes
      z.set(name, 46);
      zentral.push(z);
      offset += lokal.length + len;
    }

    const zSize = zentral.reduce((n, z) => n + z.length, 0);
    const ende = new Uint8Array(22);
    const ev = new DataView(ende.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, dateien.length, true);
    ev.setUint16(10, dateien.length, true);
    ev.setUint32(12, zSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...teile, ...zentral, ende], { type: XLSX_MIME });
  }

  const xesc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const roh = (s) => new TextEncoder().encode(s);

  function spalte(n) {
    let s = "";
    n++;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
    return s;
  }

  /** Excel-Seriennummer (Bezugstag 30.12.1899). */
  function excelDatum(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  /* Stile: 0 Standard · 1 Kopfzeile · 2 Euro · 3 Datum · 4 Summe(€) · 5 Summe(Text) · 6 fett */
  function zelle(sp, zeile, wert, stil) {
    const ref = spalte(sp) + zeile;
    const s = stil ? ` s="${stil}"` : "";
    if (wert === null || wert === undefined || wert === "") return `<c r="${ref}"${s}/>`;
    if (typeof wert === "number") return `<c r="${ref}"${s}><v>${wert}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xesc(wert)}</t></is></c>`;
  }

  function blatt(zeilen, breiten, filterBis) {
    const cols = breiten
      .map((b, i) => `<col min="${i + 1}" max="${i + 1}" width="${b}" customWidth="1"/>`)
      .join("");
    const letzteSpalte = spalte(breiten.length - 1);
    const body = zeilen
      .map((z, i) => `<row r="${i + 1}"${i === 0 ? ' ht="20" customHeight="1"' : ""}>${
        z.map((c, k) => zelle(k, i + 1, c.v, c.s)).join("")}</row>`)
      .join("");
    return roh(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<dimension ref="A1:${letzteSpalte}${Math.max(zeilen.length, 1)}"/>` +
      '<sheetViews><sheetView workbookViewId="0">' +
      (filterBis ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : "") +
      "</sheetView></sheetViews>" +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      `<cols>${cols}</cols><sheetData>${body}</sheetData>` +
      (filterBis ? `<autoFilter ref="A1:${letzteSpalte}${filterBis}"/>` : "") +
      "</worksheet>"
    );
  }

  function stylesXml() {
    return roh(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2">' +
      '<numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/>' +
      '<numFmt numFmtId="165" formatCode="DD\\.MM\\.YYYY"/>' +
      "</numFmts>" +
      '<fonts count="3">' +
      '<font><sz val="11"/><color rgb="FF1A1A1A"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF1A1A1A"/><name val="Calibri"/></font>' +
      "</fonts>" +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF2F4858"/><bgColor indexed="64"/></patternFill></fill>' +
      "</fills>" +
      '<borders count="2">' +
      "<border><left/><right/><top/><bottom/><diagonal/></border>" +
      '<border><left/><right/><top style="thin"><color rgb="FF7A8B99"/></top><bottom/><diagonal/></border>' +
      "</borders>" +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="7">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }

  function arbeitsmappe(umfang) {
    const liste = auswahl(umfang);

    /* --- Blatt 1: Rechnungen --- */
    const kopf = ["Nummer", "Bezeichnung", "Debitor", "Status", "Betrag", "Rechnungsdatum",
      "Fällig bis", "Bezahlt am", "Überfällig", "Mahnstufe", "1. Mahnung", "2. Mahnung",
      "3. Mahnung", "Beleg", "Notiz"];
    const z1 = [kopf.map((t) => ({ v: t, s: 1 }))];
    for (const i of liste) {
      z1.push([
        { v: i.number }, { v: i.name }, { v: i.debtor },
        { v: (STATUS[i.status] || {}).label || i.status },
        { v: Number(i.amount) || 0, s: 2 },
        { v: excelDatum(i.date), s: 3 },
        { v: excelDatum(i.dueDate), s: 3 },
        { v: excelDatum(i.paidDate), s: 3 },
        { v: isOverdue(i) ? "ja" : "" },
        { v: mahnstufe(i) || "" },
        { v: excelDatum(i.mahnungen && i.mahnungen["1"]), s: 3 },
        { v: excelDatum(i.mahnungen && i.mahnungen["2"]), s: 3 },
        { v: excelDatum(i.mahnungen && i.mahnungen["3"]), s: 3 },
        { v: !i.pdf ? "" : i.pdf.type === "link" ? i.pdf.url : "PDF im Vault" },
        { v: i.notes || "" },
      ]);
    }
    z1.push([{ v: "", s: 5 }, { v: "", s: 5 }, { v: "", s: 5 },
      { v: `Summe (${liste.length})`, s: 5 }, { v: summe(liste), s: 4 },
      ...Array(10).fill({ v: "", s: 5 })]);

    /* --- Blatt 2: Auswertung --- */
    const z2 = [
      [{ v: "Honorar-Übersicht – Auswertung", s: 6 }],
      [{ v: "Erstellt am" }, { v: new Date().toLocaleString("de-DE") }],
      [{ v: "Auswahl" }, { v: auswahlText(umfang) }],
      [{ v: "Rechnungen" }, { v: liste.length }],
      [],
      [{ v: "Nach Status", s: 1 }, { v: "Anzahl", s: 1 }, { v: "Betrag", s: 1 }],
    ];
    for (const [key, def] of Object.entries(STATUS)) {
      const teil = liste.filter((i) => i.status === key);
      z2.push([{ v: def.label }, { v: teil.length }, { v: summe(teil), s: 2 }]);
    }
    const ueber = liste.filter(isOverdue);
    z2.push([{ v: "davon überfällig", s: 6 }, { v: ueber.length, s: 6 }, { v: summe(ueber), s: 4 }]);
    z2.push([]);
    z2.push([{ v: "Nach Debitor", s: 1 }, { v: "Anzahl", s: 1 }, { v: "Betrag", s: 1 }]);
    const proDebitor = new Map();
    for (const i of liste) {
      const k = i.debtor || "(ohne)";
      if (!proDebitor.has(k)) proDebitor.set(k, []);
      proDebitor.get(k).push(i);
    }
    for (const [k, v] of [...proDebitor.entries()].sort((a, b) => summe(b[1]) - summe(a[1]))) {
      z2.push([{ v: k }, { v: v.length }, { v: summe(v), s: 2 }]);
    }
    z2.push([{ v: "Gesamt", s: 5 }, { v: liste.length, s: 5 }, { v: summe(liste), s: 4 }]);

    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    return zip([
      { name: "[Content_Types].xml", bytes: roh(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>") },
      { name: "_rels/.rels", bytes: roh(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
        "</Relationships>") },
      { name: "xl/workbook.xml", bytes: roh(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        `xmlns:r="${REL}"><sheets>` +
        '<sheet name="Rechnungen" sheetId="1" r:id="rId1"/>' +
        '<sheet name="Auswertung" sheetId="2" r:id="rId2"/>' +
        "</sheets></workbook>") },
      { name: "xl/_rels/workbook.xml.rels", bytes: roh(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/>` +
        "</Relationships>") },
      { name: "xl/styles.xml", bytes: stylesXml() },
      { name: "xl/worksheets/sheet1.xml", bytes: blatt(z1,
        [16, 46, 14, 26, 14, 16, 14, 14, 11, 11, 13, 13, 13, 30, 34], z1.length - 1) },
      { name: "xl/worksheets/sheet2.xml", bytes: blatt(z2, [30, 12, 16], 0) },
    ]);
  }

  async function exportExcel(umfang) {
    const name = await speichern(dateiName(".xlsx"), arbeitsmappe(umfang),
      XLSX_MIME, "Excel-Arbeitsmappe", ".xlsx");
    return name && `Als „${name}“ gespeichert – zwei Blätter: Rechnungen und Auswertung.`;
  }

  /* ================= PDF über den Druckbericht ================= */

  function berichtBauen(umfang) {
    const liste = auswahl(umfang);
    const ziel = document.getElementById("printReport");
    const zeile = (i) => `<tr${isOverdue(i) ? ' class="pr-over"' : ""}>
      <td>${esc(i.number)}</td>
      <td>${esc(i.name)}</td>
      <td>${esc(i.debtor)}</td>
      <td>${(STATUS[i.status] || {}).emoji || ""} ${esc((STATUS[i.status] || {}).label || i.status)}</td>
      <td class="pr-num">${fmtEUR.format(Number(i.amount) || 0)}</td>
      <td>${esc(fmtDate(i.date))}</td>
      <td>${esc(fmtDate(i.dueDate))}${isOverdue(i) ? " <b>überfällig</b>" : ""}</td>
      <td>${esc(fmtDate(i.paidDate))}</td>
      <td>${mahnstufe(i) ? mahnstufe(i) + ". Mahnung" : ""}</td>
    </tr>`;

    const proStatus = Object.entries(STATUS).map(([k, d]) => {
      const teil = liste.filter((i) => i.status === k);
      return `<tr><td>${d.emoji} ${esc(d.label)}</td><td class="pr-num">${teil.length}</td>
              <td class="pr-num">${fmtEUR.format(summe(teil))}</td></tr>`;
    }).join("");
    const ueber = liste.filter(isOverdue);

    ziel.innerHTML = `
      <div class="pr-kopf">
        <h1>Honorar-Übersicht</h1>
        <div class="pr-meta">
          <div>Stand: ${new Date().toLocaleString("de-DE")}</div>
          <div>Auswahl: ${esc(auswahlText(umfang))}</div>
        </div>
      </div>
      <table class="pr-sum">
        <thead><tr><th>Status</th><th class="pr-num">Anzahl</th><th class="pr-num">Betrag</th></tr></thead>
        <tbody>${proStatus}
          <tr class="pr-warn"><td>davon überfällig</td><td class="pr-num">${ueber.length}</td>
              <td class="pr-num">${fmtEUR.format(summe(ueber))}</td></tr>
          <tr class="pr-ges"><td>Gesamt</td><td class="pr-num">${liste.length}</td>
              <td class="pr-num">${fmtEUR.format(summe(liste))}</td></tr>
        </tbody>
      </table>
      <table class="pr-table">
        <thead><tr><th>Nummer</th><th>Bezeichnung</th><th>Debitor</th><th>Status</th>
          <th class="pr-num">Betrag</th><th>Rechnung</th><th>Fällig</th><th>Bezahlt</th><th>Mahnung</th></tr></thead>
        <tbody>${liste.map(zeile).join("")}</tbody>
        <tfoot><tr><td colspan="4">Summe · ${liste.length} Rechnungen</td>
          <td class="pr-num">${fmtEUR.format(summe(liste))}</td><td colspan="4"></td></tr></tfoot>
      </table>
      <div class="pr-fuss">Honorar-Übersicht · vertraulich · erzeugt am ${new Date().toLocaleDateString("de-DE")}</div>`;
    return liste.length;
  }

  function berichtLeeren() {
    const el = document.getElementById("printReport");
    if (el) el.replaceChildren();
    document.body.classList.remove("report-print");
  }

  function alsPdf(umfang) {
    const n = berichtBauen(umfang);
    if (!n) { toast("Für diese Auswahl gibt es keine Rechnungen."); return; }
    document.body.classList.add("report-print");
    const fertig = () => { berichtLeeren(); window.removeEventListener("afterprint", fertig); };
    window.addEventListener("afterprint", fertig);
    setTimeout(() => window.print(), 60);
  }

  /* ================= Import ================= */

  function trenner(kopf) {
    return [";", "\t", ","].map((c) => [c, kopf.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
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
  function zahl(v) {
    if (typeof v === "number") return v;
    let t = String(v ?? "").replace(/[€\s ']/g, "");
    if (!t) return 0;
    const k = t.lastIndexOf(","), p = t.lastIndexOf(".");
    if (k > -1 && p > -1) t = k > p ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    else if (k > -1) t = t.replace(/\./g, "").replace(",", ".");
    const n = parseFloat(t);
    return isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }
  function datum(v) {
    const s = String(v ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = (+y > 70 ? "19" : "20") + y;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    return "";
  }
  /* Reihenfolge ist entscheidend: „Offen – nicht bezahlt“ enthaelt das Wort
     „bezahlt“, deshalb wird zuerst auf die Verneinung geprueft. */
  function statusLesen(v) {
    const s = String(v ?? "").toLowerCase().trim();
    if (!s) return "offen";
    if (/nicht bezahlt|unbezahlt|offen|open|unpaid|🔴|rot/.test(s)) return "offen";
    if (/verschickt|versendet|sent|wartet|stand-?by|🟡|gelb/.test(s)) return "verschickt";
    if (/bezahlt|paid|erledigt|🟢|gr[üu]n/.test(s)) return "bezahlt";
    return "offen";
  }

  function ausCsv(txt) {
    const zeilen = txt.split(/\r?\n/).filter((z) => z.trim());
    if (zeilen.length < 2) return [];
    const sep = trenner(zeilen[0]);
    const kopf = csvZeile(zeilen[0], sep).map((h) => h.toLowerCase());
    const f = (...n) => kopf.findIndex((h) => n.some((x) => h.includes(x)));
    const iNr = f("nummer", "number", "rechnungsnr"), iName = f("bezeichn", "name", "beschreib"),
      iBet = f("betrag", "amount", "summe"), iDeb = f("debitor", "debtor", "kunde"),
      iSt = f("status", "ampel"), iDat = f("rechnungsdatum", "datum", "date"),
      iFae = f("fällig", "faellig", "due"), iBez = f("bezahlt am", "bezahlt", "paid"),
      iNot = f("notiz", "note", "bemerk"),
      iM = ["1. mahnung", "2. mahnung", "3. mahnung"].map((n) => kopf.indexOf(n));
    const raus = [];
    for (let i = 1; i < zeilen.length; i++) {
      const c = csvZeile(zeilen[i], sep);
      const nummer = iNr > -1 ? c[iNr] : "";
      const name = iName > -1 ? c[iName] : "";
      if (!nummer && !name) continue;
      if (/^summe/i.test(nummer) || (iSt < 0 && /^summe/i.test(name))) continue;
      const inv = {
        id: crypto.randomUUID(), currency: "EUR",
        number: nummer || "(ohne Nummer)", name: name || "(ohne Bezeichnung)",
        amount: iBet > -1 ? zahl(c[iBet]) : 0,
        debtor: (iDeb > -1 && c[iDeb]) || (state.data.debtors[0] || "LaLux"),
        status: iSt > -1 ? statusLesen(c[iSt]) : "offen",
        date: iDat > -1 ? datum(c[iDat]) : "",
        dueDate: iFae > -1 ? datum(c[iFae]) : "",
        notes: iNot > -1 ? c[iNot] || "" : "",
        mahnungen: {},
      };
      if (iBez > -1 && datum(c[iBez])) inv.paidDate = datum(c[iBez]);
      if (inv.status === "bezahlt" && !inv.paidDate) inv.paidDate = todayIso();
      iM.forEach((idx, k) => { if (idx > -1 && datum(c[idx])) inv.mahnungen[String(k + 1)] = datum(c[idx]); });
      raus.push(inv);
    }
    return raus;
  }

  const ausSicherung = (o, quelle) => ({
    quelle,
    invoices: Array.isArray(o.invoices) ? o.invoices : [],
    debtors: Array.isArray(o.debtors) ? o.debtors : [],
    pdfs: o.pdfs && typeof o.pdfs === "object" ? o.pdfs : {},
  });

  /** Liest eine Import-Datei. Verschluesselte Dateien brauchen ggf. eine Passphrase. */
  async function lesen(datei, passphrase) {
    const name = datei.name.toLowerCase();
    if (name.endsWith(".enc")) {
      const bytes = new Uint8Array(await datei.arrayBuffer());
      if (!PfaCrypto.istTbv1(bytes)) throw new Error("Unbekanntes Dateiformat.");
      if (!passphrase) { const e = new PfaCrypto.DecryptError("Passphrase nötig."); e.brauchtGeheimnis = true; throw e; }
      const klar = await PfaCrypto.tbv1Entschluesseln(passphrase, bytes);
      return ausSicherung(JSON.parse(new TextDecoder().decode(klar)), "Alte Honorar-Sicherung");
    }
    const txt = (await datei.text()).replace(/^\ufeff/, "");
    if (name.endsWith(".json") || /^\s*[{[]/.test(txt)) {
      const o = JSON.parse(txt);
      if (Pfa.istSicherung(o)) {
        if (o.modul && o.modul !== "honorar" && o.modul !== "alle") {
          throw new Error("Das ist eine Finanz-Sicherung – bitte im Bereich Finanzen importieren.");
        }
        const roh = await Pfa.sicherungOeffnen(o, passphrase);
        return ausSicherung(roh, "Verschlüsselte Sicherung");
      }
      const inv = Array.isArray(o) ? o : Array.isArray(o.invoices) ? o.invoices : [];
      return { quelle: "JSON-Datei", invoices: inv,
        debtors: Array.isArray(o.debtors) ? o.debtors : [], pdfs: {} };
    }
    if (name.endsWith(".xlsx")) {
      throw new Error("Excel-Dateien lassen sich nicht direkt einlesen. " +
        "In Excel bitte „Ablage → Exportieren → CSV (Trennzeichen ;)“ wählen.");
    }
    return { quelle: "CSV-Datei", invoices: ausCsv(txt), debtors: [], pdfs: {} };
  }

  /** Setzt einen gelesenen Import in die Daten um. Gibt einen Bericht zurueck. */
  function anwenden(gelesen, modus) {
    const sauber = normalizeData({
      version: 1,
      debtors: [...new Set([...state.data.debtors, ...gelesen.debtors,
        ...gelesen.invoices.map((i) => i.debtor).filter(Boolean)])],
      /* "pdfFile" ist ein Hinweis fuer das Kommandozeilen-Werkzeug (lokaler Pfad)
         und hat im Vault nichts verloren. */
      invoices: gelesen.invoices.map((i) => { const k = { ...i }; delete k.pdfFile; return k; }),
    });
    let neu = sauber.invoices.length, uebersprungen = 0;
    if (modus === "replace") {
      state.data.invoices = sauber.invoices;
    } else {
      const bekannt = new Set(state.data.invoices.map((i) => String(i.number).trim().toLowerCase()));
      const frisch = [];
      for (const inv of sauber.invoices) {
        const k = String(inv.number).trim().toLowerCase();
        if (bekannt.has(k)) { uebersprungen++; continue; }
        bekannt.add(k);
        frisch.push(inv);
      }
      state.data.invoices.push(...frisch);
      neu = frisch.length;
    }
    state.data.debtors = sauber.debtors;
    normalizeData(state.data);
    return { neu, uebersprungen };
  }

  return {
    exportExcel, exportCsv, exportJson, exportSicherung, alsPdf,
    lesen, anwenden, auswahl, auswahlText, berichtLeeren, speichern,
    get pickerNutzbar() { return pickerNutzbar; },
  };
})();

/* ================= Oberflaeche verdrahten ================= */

document.addEventListener("DOMContentLoaded", () => {
  const el = (id) => document.getElementById(id);
  const { toast, busy } = Pfa;
  const { state, saveData, snapshotData, restoreData, render } = Honorar;

  let gelesen = null;          // zuletzt eingelesene Datei
  let importSnapshot = null;   // Stand vor einem nicht gespeicherten Import

  /* ---------- Export ---------- */

  const umfang = () =>
    document.querySelector("#exportForm input[name=scope]:checked").value;

  el("exportBtn").addEventListener("click", () => {
    if (!state.data) return;
    el("scopeAllLabel").textContent = `Alle Rechnungen (${state.data.invoices.length})`;
    el("scopeFilterLabel").textContent =
      `Nur die aktuelle Auswahl (${Reports.auswahl("filter").length}) – ${Reports.auswahlText("filter")}`;
    el("exportHint").textContent = Reports.pickerNutzbar
      ? "Beim Speichern fragt der Browser nach Ordner und Dateiname – die Datei kann also direkt in OneDrive landen."
      : "Dieser Browser fragt nicht nach: Die Datei landet im Download-Ordner (auf dem Mac ~/Downloads).";
    el("exportDialog").showModal();
  });

  async function lauf(fn, arbeitstext) {
    if (!state.data) return;
    try {
      busy(arbeitstext || "Datei wird erzeugt …");
      const meldung = await fn();
      if (meldung) { el("exportDialog").close(); toast(meldung, 6000); }
    } catch (e) {
      toast(`Export fehlgeschlagen: ${e.message}`, 6000);
    } finally {
      busy(false);
    }
  }

  el("expXlsx").addEventListener("click", () => lauf(() => Reports.exportExcel(umfang())));
  el("hExpJson").addEventListener("click", () => lauf(() => Reports.exportJson(umfang())));
  el("hExpCsv").addEventListener("click", () => lauf(() => Reports.exportCsv(umfang())));
  el("expOwnPass").addEventListener("change", () => {
    el("expPassField").hidden = !el("expOwnPass").checked;
    if (el("expOwnPass").checked) el("expPassField").focus(); else el("expPassField").value = "";
  });
  el("expEnc").addEventListener("click", () => {
    const eigene = el("expOwnPass").checked ? el("expPassField").value : "";
    if (el("expOwnPass").checked && eigene.length < 12) {
      toast("Die eigene Passphrase braucht mindestens 12 Zeichen.", 5000);
      el("expPassField").focus();
      return;
    }
    lauf(() => Reports.exportSicherung(umfang(), el("expWithPdfs").checked, eigene),
         "Sicherung wird erstellt …");
  });
  el("expPdf").addEventListener("click", () => {
    el("exportDialog").close();
    Reports.alsPdf(umfang());
  });

  /* ---------- Import ---------- */

  function importZuruecksetzen() {
    gelesen = null;
    el("importFile").value = "";
    el("importPass").value = "";
    el("importPassWrap").hidden = true;
    el("importInfo").hidden = true;
    el("importError").hidden = true;
    el("importApplyBtn").disabled = true;
  }

  el("importBtn").addEventListener("click", () => {
    if (!state.data) return;
    importZuruecksetzen();
    el("importAdminHint").hidden = state.admin.active;   // vorher warnen, nicht hinterher
    el("importPassWrap").hidden = true;
    el("importDialog").showModal();
  });

  const drop = el("importDrop");
  drop.addEventListener("click", () => el("importFile").click());
  el("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) datei(e.target.files[0]);
  });
  for (const t of ["dragenter", "dragover"]) {
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const t of ["dragleave", "drop"]) {
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) datei(f);
  });

  let letzteDatei = null;
  async function datei(f) {
    letzteDatei = f;
    el("importError").hidden = true;
    el("importInfo").hidden = true;
    el("importApplyBtn").disabled = true;
    try {
      busy("Datei wird gelesen …");
      gelesen = await Reports.lesen(f, el("importPass").value || undefined);
      el("importPassWrap").hidden = true;
      if (!gelesen.invoices.length) throw new Error("In dieser Datei stehen keine Rechnungen.");
      const anzPdf = Object.keys(gelesen.pdfs || {}).length;
      el("importInfo").textContent =
        `${gelesen.quelle}: ${gelesen.invoices.length} Rechnung(en) erkannt` +
        (anzPdf ? `, dazu ${anzPdf} PDF(s) in der Sicherung` : "") + ` – „${f.name}“.`;
      el("importInfo").hidden = false;
      el("importApplyBtn").disabled = false;
    } catch (e) {
      gelesen = null;
      const falschePass = e instanceof PfaCrypto.DecryptError || e.brauchtGeheimnis;
      if (falschePass) { el("importPassWrap").hidden = false; el("importPass").focus(); }
      el("importError").textContent = falschePass
        ? "Diese Sicherung braucht ihre eigene Passphrase (oder den Wiederherstellungsschlüssel). Bitte eintragen und die Datei erneut wählen."
        : e.message;
      el("importError").hidden = false;
    } finally {
      busy(false);
    }
  }

  el("importPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (letzteDatei) datei(letzteDatei); }
  });

  // Gleiche Falle wie beim Zuruecksetzen: Enter im Passwortfeld wuerde den
  // Dialog ueber die implizite Formular-Absendung wortlos schliessen.
  for (const id of ["importForm", "exportForm"]) {
    document.getElementById(id).addEventListener("submit", (e) => e.preventDefault());
  }

  el("importApplyBtn").addEventListener("click", async () => {
    if (!gelesen || state.opBusy) return;
    const modus = document.querySelector("#importForm input[name=imode]:checked").value;
    const vorher = snapshotData();
    state.opBusy = true;
    try {
      const bericht = Reports.anwenden(gelesen, modus);
      if (state.admin.active) {
        // PDFs aus der Sicherung wieder in den Vault legen (nur fuer uebernommene Rechnungen)
        const pdfs = gelesen.pdfs || {};
        const mitPdf = state.data.invoices.filter((i) => i.pdf && i.pdf.type === "vault" && pdfs[i.id]);
        let n = 0;
        for (const inv of mitPdf) {
          busy(`PDF ${++n} von ${mitPdf.length} wird in den Vault gelegt …`);
          await Pfa.pdfSchreiben(inv.pdf.file, PfaCrypto.vonB64(pdfs[inv.id]), "Restore encrypted invoice PDF");
        }
        busy("Rechnungen werden im Vault gespeichert …");
        await saveData(`Import: ${bericht.neu} Rechnung(en)`);
        el("importBanner").hidden = true;
        importSnapshot = null;
        toast(
          `${bericht.neu} Rechnung(en) importiert und gespeichert` +
          (bericht.uebersprungen ? ` · ${bericht.uebersprungen} vorhandene übersprungen` : "") + ".", 7000
        );
      } else {
        if (!importSnapshot) importSnapshot = vorher;
        el("importBannerText").textContent =
          `Importierte Ansicht (${bericht.neu} Rechnung(en)) – nur angesehen, nicht gespeichert. ` +
          "Zum Übernehmen bitte die Verwaltung aktivieren und erneut importieren.";
        el("importBanner").hidden = false;
        toast(`${bericht.neu} Rechnung(en) geladen – noch nicht gespeichert.`, 6000);
      }
      el("importDialog").close();
      importZuruecksetzen();
    } catch (e) {
      if (!e.vaultReloaded) restoreData(vorher);
      el("importError").textContent = `Speichern fehlgeschlagen: ${e.message}`;
      el("importError").hidden = false;
    } finally {
      state.opBusy = false;
      busy(false);
      render();
    }
  });

  el("importDiscardBtn").addEventListener("click", () => {
    if (importSnapshot) restoreData(importSnapshot);
    importSnapshot = null;
    el("importBanner").hidden = true;
    render();
    toast("Importierte Ansicht verworfen.");
  });
});
