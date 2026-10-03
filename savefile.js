// Format des .sav F1 Manager 22/23/24 :
//   [header GVAS ... "None\0" "None\0"] [4 octets inconnus]
//   [int32 taille zlib] [int32 taille main.db] [int32 taille backup1.db] [int32 taille backup2.db]
//   [zlib(main.db + backup1.db + backup2.db)]
// Même logique que F1-Manager-2022-SaveFile-Repacker (script.py) et f1dbeditor (UESaveHandler.js).
(function (root) {
  "use strict";

  const NONE_NONE_SIG = [0x00, 0x05, 0, 0, 0, 0x4e, 0x6f, 0x6e, 0x65, 0x00, 0x05, 0, 0, 0, 0x4e, 0x6f, 0x6e, 0x65, 0x00];

  function indexesOf(u8, pat) {
    const out = [];
    outer: for (let i = 0; i <= u8.length - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (u8[i + j] !== pat[j]) continue outer;
      out.push(i);
    }
    return out;
  }

  function latin1(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return s;
  }

  function detectGame(header) {
    const txt = latin1(header);
    const build = (txt.match(/\+\+[\x20-\x7e]+/) || [""])[0];
    const m = build.match(/volta(\d\d)/i) || build.match(/F1Manager(\d\d)/i) || txt.match(/F1Manager(\d\d)/i);
    return { buildId: build, game: m ? "F1 Manager " + m[1] : "Inconnu" };
  }

  // inflate: (Uint8Array) => Uint8Array
  function parseSave(u8, inflate) {
    if (latin1(u8.subarray(0, 4)) !== "GVAS") throw new Error("Ce fichier n'est pas une save Unreal (en-tête GVAS absent).");
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    for (const idx of indexesOf(u8, NONE_NONE_SIG)) {
      const off = idx + NONE_NONE_SIG.length + 4; // + 4 octets inconnus
      if (off + 16 > u8.length) continue;
      const zlen = dv.getInt32(off, true);
      const sizes = [dv.getInt32(off + 4, true), dv.getInt32(off + 8, true), dv.getInt32(off + 12, true)];
      const dataStart = off + 16;
      if (zlen <= 0 || dataStart + zlen > u8.length || sizes[0] <= 0 || sizes.some(s => s < 0)) continue;
      if (u8[dataStart] !== 0x78) continue; // en-tête zlib

      const raw = inflate(u8.subarray(dataStart, dataStart + zlen));
      if (raw.length !== sizes[0] + sizes[1] + sizes[2]) continue;

      const dbs = [];
      let p = 0;
      for (const s of sizes) { dbs.push(raw.slice(p, p + s)); p += s; }
      const header = u8.slice(0, off);
      return {
        header,
        dbs, // [main.db, backup1.db, backup2.db]
        trailing: u8.slice(dataStart + zlen),
        ...detectGame(header),
      };
    }
    throw new Error("Section base de données introuvable dans la save.");
  }

  // deflate: (Uint8Array) => Uint8Array
  function buildSave(header, dbs, deflate, trailing) {
    const sizes = [0, 1, 2].map(i => (dbs[i] ? dbs[i].length : 0));
    const raw = new Uint8Array(sizes[0] + sizes[1] + sizes[2]);
    let p = 0;
    for (let i = 0; i < 3; i++) if (sizes[i]) { raw.set(dbs[i], p); p += sizes[i]; }
    const comp = deflate(raw);
    const tail = trailing || new Uint8Array(0);

    const out = new Uint8Array(header.length + 16 + comp.length + tail.length);
    const dv = new DataView(out.buffer);
    out.set(header, 0);
    dv.setInt32(header.length, comp.length, true);
    sizes.forEach((s, i) => dv.setInt32(header.length + 4 + 4 * i, s, true));
    out.set(comp, header.length + 16);
    out.set(tail, header.length + 16 + comp.length);
    return out;
  }

  root.F1Save = { parseSave, buildSave, detectGame };
})(typeof window !== "undefined" ? window : globalThis);
