/*
 * PFA – Kryptographie (Zero-Knowledge, ausschliesslich im Browser)
 * ---------------------------------------------------------------
 * Ein zufaelliger Datenschluessel (AES-256-GCM, "DEK") verschluesselt alle
 * Vault-Dateien. Er liegt zweimal verpackt im Schluesselbund (keyring.json):
 * einmal mit der Passphrase, einmal mit dem Wiederherstellungsschluessel --
 * beide ueber PBKDF2-SHA-256 (600 000 Runden) abgeleitet. Weder Passphrase
 * noch Wiederherstellungsschluessel noch eine Pruefsumme davon werden
 * gespeichert.
 *
 * Dateiformat "PFA1" (finanz.enc, honorar.enc, pdf/*.enc):
 *   Bytes 0-3   ASCII "PFA1"
 *   Bytes 4-15  IV / Nonce (12 Bytes)
 *   Bytes 16-.. AES-256-GCM Ciphertext inkl. 16-Byte-Auth-Tag (Schluessel = DEK)
 *
 * Dateiformat "TBV1" (Altformat der Honorar-Uebersicht, nur noch fuer den
 * Import alter Sicherungen): Magic, Salt 16, Iterationen uint32BE, IV 12, CT.
 *
 * Das Python-Gegenstueck ist tools/pfa_vault.py.
 */
"use strict";

const PfaCrypto = (() => {
  const RUNDEN = 600000;
  const RK_ZEICHEN = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford-Base32, ohne I L O U
  const MAGIC_PFA = [0x50, 0x46, 0x41, 0x31]; // "PFA1"
  const MAGIC_TBV = [0x54, 0x42, 0x56, 0x31]; // "TBV1"
  const IV_LEN = 12;
  const txtEnc = new TextEncoder();
  const txtDec = new TextDecoder();

  const zufall = (n) => crypto.getRandomValues(new Uint8Array(n));

  class DecryptError extends Error {
    constructor(message) {
      super(message);
      this.name = "DecryptError";
    }
  }

  function b64(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function vonB64(s) {
    const bin = atob(String(s).replace(/\s/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  /* ---------- Schluesselableitung / Huellen ---------- */

  async function ableiten(geheim, salt, runden) {
    const roh = await crypto.subtle.importKey("raw", txtEnc.encode(geheim), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: runden || RUNDEN, hash: "SHA-256" },
      roh, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  const neuerSchluessel = () =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

  /** Verpackt den Datenschluessel mit einem Geheimnis (Passphrase oder Wiederherstellungsschluessel). */
  async function huelleBauen(schluessel, geheim, runden) {
    const salt = zufall(16), iv = zufall(IV_LEN);
    const kek = await ableiten(geheim, salt, runden || RUNDEN);
    const roh = await crypto.subtle.exportKey("raw", schluessel);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, roh);
    return { salt: b64(salt), iv: b64(iv), paket: b64(ct), runden: runden || RUNDEN };
  }

  /** Oeffnet eine Huelle. Wirft DecryptError bei falschem Geheimnis. */
  async function huelleOeffnen(h, geheim) {
    if (!h || !h.salt || !h.iv || !h.paket) throw new DecryptError("Huelle unvollständig.");
    const kek = await ableiten(geheim, vonB64(h.salt), h.runden);
    let roh;
    try {
      roh = await crypto.subtle.decrypt({ name: "AES-GCM", iv: vonB64(h.iv) }, kek, vonB64(h.paket));
    } catch (e) {
      throw new DecryptError("Geheimnis passt nicht.");
    }
    return crypto.subtle.importKey("raw", roh, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }

  /** 24 Zeichen Crockford-Base32 (120 Bit), in Vierergruppen. */
  function neuerWiederherstellungsschluessel() {
    const b = zufall(24);
    let s = "";
    for (let i = 0; i < 24; i++) s += RK_ZEICHEN[b[i] % 32]; // 256 % 32 == 0 -> unverzerrt
    return s.match(/.{4}/g).join("-");
  }

  const rkNorm = (s) => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1").replace(/O/g, "0").replace(/U/g, "V");

  /* ---------- Sitzungsschluessel (roh) ---------- */

  const exportRoh = async (key) => b64(await crypto.subtle.exportKey("raw", key));
  const importRoh = (s) =>
    crypto.subtle.importKey("raw", vonB64(s), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);

  /* ---------- PFA1: Dateien mit dem Datenschluessel ---------- */

  async function verschluesselnBytes(key, plainBytes) {
    const iv = zufall(IV_LEN);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes));
    const kopf = new Uint8Array(4 + IV_LEN);
    kopf.set(MAGIC_PFA, 0);
    kopf.set(iv, 4);
    return concat(kopf, ct);
  }

  async function entschluesselnBytes(key, fileBytes) {
    if (!(fileBytes instanceof Uint8Array)) fileBytes = new Uint8Array(fileBytes);
    if (fileBytes.length < 4 + IV_LEN + 16) throw new DecryptError("Datei zu kurz oder beschädigt.");
    for (let i = 0; i < 4; i++) {
      if (fileBytes[i] !== MAGIC_PFA[i]) throw new DecryptError("Kein PFA-Vaultformat.");
    }
    const iv = fileBytes.slice(4, 4 + IV_LEN);
    const ct = fileBytes.slice(4 + IV_LEN);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    } catch (e) {
      throw new DecryptError("Entschlüsselung fehlgeschlagen – Schlüssel falsch oder Datei beschädigt.");
    }
  }

  const verschluesselnJson = (key, obj) => verschluesselnBytes(key, txtEnc.encode(JSON.stringify(obj)));
  const entschluesselnJson = async (key, bytes) => JSON.parse(txtDec.decode(await entschluesselnBytes(key, bytes)));

  /* ---------- JSON-Pakete {iv, inhalt} (Sicherungen, Altformat Finanz) ---------- */

  async function paketBauen(key, obj) {
    const iv = zufall(IV_LEN);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, txtEnc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), inhalt: b64(ct) };
  }

  async function paketOeffnen(key, paket) {
    try {
      const roh = await crypto.subtle.decrypt({ name: "AES-GCM", iv: vonB64(paket.iv) }, key, vonB64(paket.inhalt));
      return JSON.parse(txtDec.decode(roh));
    } catch (e) {
      throw new DecryptError("Paket lässt sich nicht öffnen.");
    }
  }

  /* ---------- TBV1: Altformat (Passphrase direkt) ---------- */

  async function tbv1Entschluesseln(passphrase, fileBytes) {
    if (fileBytes.length < 36 + 16) throw new DecryptError("Datei zu kurz oder beschädigt.");
    for (let i = 0; i < 4; i++) {
      if (fileBytes[i] !== MAGIC_TBV[i]) throw new DecryptError("Kein TBV1-Format.");
    }
    const salt = fileBytes.slice(4, 20);
    const iterations = new DataView(fileBytes.buffer, fileBytes.byteOffset + 20, 4).getUint32(0, false);
    if (iterations < 1000 || iterations > 10000000) throw new DecryptError("Ungültige KDF-Parameter.");
    const iv = fileBytes.slice(24, 36);
    const key = await ableiten(passphrase, salt, iterations);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fileBytes.slice(36)));
    } catch (e) {
      throw new DecryptError("Passphrase falsch oder Datei beschädigt.");
    }
  }

  const istPfa1 = (bytes) => bytes.length > 4 && MAGIC_PFA.every((m, i) => bytes[i] === m);
  const istTbv1 = (bytes) => bytes.length > 4 && MAGIC_TBV.every((m, i) => bytes[i] === m);

  return {
    RUNDEN, DecryptError, b64, vonB64, zufall,
    ableiten, neuerSchluessel, huelleBauen, huelleOeffnen,
    neuerWiederherstellungsschluessel, rkNorm,
    exportRoh, importRoh,
    verschluesselnBytes, entschluesselnBytes, verschluesselnJson, entschluesselnJson,
    paketBauen, paketOeffnen, tbv1Entschluesseln, istPfa1, istTbv1,
  };
})();
