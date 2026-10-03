"use strict";

/* ---------- utilitaires ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const qi = name => '"' + String(name).replace(/"/g, '""') + '"';
const NUM_TYPE = /INT|DEC|REAL|FLOA|DOUB|NUM/i;

const S = {
  SQL: null, db: null, save: null, fileName: null, handle: null, origBytes: null,
  undo: [], journal: [], edited: new Set(), dirty: false, backupDone: false,
  playerTeam: null, grids: [], tableCache: null, batch: null,
};

const sqlReady = initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/${f}` })
  .then(SQL => (S.SQL = SQL))
  .catch(e => toast("Impossible de charger sql.js (connexion internet requise au premier lancement) : " + e.message, true));

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), err ? 6000 : 2500);
}

function q(sql, params = []) {
  const st = S.db.prepare(sql);
  try {
    st.bind(params);
    const cols = st.getColumnNames();
    const rows = [];
    while (st.step()) rows.push(st.get());
    return { cols, rows };
  } finally {
    st.free();
  }
}
const q1 = (sql, params) => { const r = q(sql, params).rows[0]; return r ? r[0] : undefined; };

function tables() {
  if (!S.tableCache) {
    S.tableCache = new Map();
    for (const [name] of q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name COLLATE NOCASE").rows) {
      const cols = q(`PRAGMA table_info(${qi(name)})`).rows.map(r => ({ name: r[1], type: r[2] || "", pk: r[5] }));
      S.tableCache.set(name, { cols, count: q1(`SELECT count(*) FROM ${qi(name)}`) });
    }
  }
  return S.tableCache;
}
const hasTable = t => tables().has(t);

function fmt(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return `<blob ${v.length} o>`;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? v.toLocaleString("fr-FR") : String(v);
    return v.toLocaleString("fr-FR", { maximumFractionDigits: 4 });
  }
  return String(v);
}
const money = v => (v == null ? "—" : Math.round(v).toLocaleString("fr-FR") + " $");

function parseInput(str, old) {
  const t = str.trim();
  if (/^null$/i.test(t)) return null;
  if (typeof old === "string") return str;
  const n = t.replace(",", ".").replace(/[\s  ]/g, "");
  if (n !== "" && isFinite(n)) return Number(n);
  const m = n.replace("$", "").match(/^(-?[\d.]+)([kKmM])$/); // 250k, 1.5M
  if (m && isFinite(m[1])) return Math.round(Number(m[1]) * (/k/i.test(m[2]) ? 1e3 : 1e6));
  if (typeof old === "number") throw new Error(`« ${str} » n'est pas un nombre`);
  return str;
}

function download(bytes, name, type = "application/octet-stream") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- modifications + annulation ---------- */
function mutate({ label, table, col, where, params = [], setExpr, setParams = [] }) {
  const before = q(`SELECT rowid, ${qi(col)} FROM ${qi(table)} WHERE ${where}`, params).rows;
  if (!before.length) return 0;
  S.db.run(`UPDATE ${qi(table)} SET ${qi(col)} = ${setExpr} WHERE ${where}`, [...setParams, ...params]);
  before.forEach(([rid]) => S.edited.add(`${table}|${rid}|${col}`));
  const part = { table, col, before };
  if (S.batch) {
    S.batch.push(part);
    return before.length;
  }
  S.undo.push({ label, parts: [part] });
  log(label);
  setDirty(true);
  return before.length;
}

// Regroupe plusieurs mutate() en une seule entrée d'annulation / de journal
function batch(label, fn) {
  S.batch = [];
  try {
    fn();
  } finally {
    const parts = S.batch;
    S.batch = null;
    if (parts.length) {
      S.undo.push({ label, parts });
      log(label);
      setDirty(true);
    }
  }
}

// Insère une ligne ; l'annulation la supprime
function insertRow(table, cols, values, label) {
  S.db.run(`INSERT INTO ${qi(table)} (${cols.map(qi).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
  const part = { table, inserted: q1("SELECT last_insert_rowid()") };
  if (S.batch) return S.batch.push(part);
  S.undo.push({ label, parts: [part] });
  log(label);
  setDirty(true);
}

// Raccourci : une valeur sur les lignes ciblées
const setValue = (table, col, where, params, value, label) =>
  mutate({ label, table, col, where, params, setExpr: "?", setParams: [value] });

function undo() {
  const u = S.undo.pop();
  if (!u) return;
  const parts = u.parts.slice().reverse();
  S.db.run("BEGIN");
  try {
    for (const p of parts) {
      if (p.inserted != null) { S.db.run(`DELETE FROM ${qi(p.table)} WHERE rowid = ?`, [p.inserted]); continue; }
      for (const [rid, v] of p.before) S.db.run(`UPDATE ${qi(p.table)} SET ${qi(p.col)} = ? WHERE rowid = ?`, [v, rid]);
    }
    S.db.run("COMMIT");
  } catch (e) {
    S.db.run("ROLLBACK");
    throw e;
  }
  parts.forEach(p => (p.before || []).forEach(([rid]) => S.edited.delete(`${p.table}|${rid}|${p.col}`)));
  log("Annulé : " + u.label);
  setDirty(true);
  refreshAll();
}

function log(text) {
  S.journal.push({ time: new Date(), text });
  renderJournal();
}

function setDirty(d) {
  S.dirty = d;
  $("#btnUndo").disabled = !S.undo.length;
  renderFileInfo();
}

function refreshAll() {
  S.grids = S.grids.filter(g => g.el.isConnected);
  S.grids.forEach(g => g.render());
}

/* ---------- colonnes intelligentes ---------- */
// Tables de libellés pour les colonnes qui référencent une autre table (TeamID → nom d'équipe, etc.)
const FK_SOURCES = {
  teams: { table: "Teams", sql: () => `SELECT TeamID, ${tables().get("Teams").cols.some(c => c.name === "TeamName") ? "COALESCE(NULLIF(TeamName,''), TeamNameLocKey)" : "TeamNameLocKey"} FROM Teams` },
  staff: { table: "Staff_BasicData", sql: "SELECT StaffID, FirstName || '|' || LastName FROM Staff_BasicData", clean: s => cleanName(s) },
  parts: { table: "Parts_Enum_Type", sql: "SELECT Value, Name FROM Parts_Enum_Type" },
  partStats: { table: "Parts_Enum_Stats", sql: "SELECT Value, Name FROM Parts_Enum_Stats" },
  staffStats: { table: "Staff_Enum_PerformanceStatTypes", sql: "SELECT Value, Name FROM Staff_Enum_PerformanceStatTypes" },
  countries: { table: "Countries", sql: "SELECT CountryID, COALESCE(EnumName, Name) FROM Countries" },
  tracks: { table: "Races_Tracks", sql: "SELECT TrackID, Name FROM Races_Tracks" },
  buildings: { table: "Buildings", sql: "SELECT BuildingID, Name FROM Buildings" },
  buildingTypes: { table: "Building_Enum_Types", sql: "SELECT Type, Name FROM Building_Enum_Types" },
  buildingStates: { table: "Building_Enum_States", sql: "SELECT State, Name FROM Building_Enum_States" },
  buildingEffects: { table: "Building_Enum_Effects", sql: "SELECT Effect, Name FROM Building_Enum_Effects" },
  contractTypes: { table: "Staff_Enum_ContractType", sql: "SELECT Value, Name FROM Staff_Enum_ContractType" },
  staffTypes: { table: "Staff_Enum_StaffType", sql: "SELECT StaffType, Name FROM Staff_Enum_StaffType" },
  devSpeeds: { table: "Parts_Enum_DevSpeeds", sql: "SELECT Value, Name FROM Parts_Enum_DevSpeeds" },
  designTypes: { table: "Parts_Enum_DesignTypes", sql: "SELECT Value, Name FROM Parts_Enum_DesignTypes" },
  raceStates: { table: "Races_Enum_State", sql: "SELECT State, Name FROM Races_Enum_State" },
  weekendTypes: { table: "Races_Enum_WeekendType", sql: "SELECT Type, Name FROM Races_Enum_WeekendType" },
  mentalityCats: { table: "Staff_Enum_MentalityCategory", sql: "SELECT Value, Name FROM Staff_Enum_MentalityCategory" },
  mentality: { table: "Staff_Enum_Mentality", sql: "SELECT Value, Name FROM Staff_Enum_Mentality" },
  mentalityStatus: { table: "Staff_Enum_MentalityStatus", sql: "SELECT Value, Name FROM Staff_Enum_MentalityStatus" },
  mentalityEvents: { table: "Staff_Enum_MentalityEvent", sql: "SELECT Value, Name FROM Staff_Enum_MentalityEvent" },
  transactionTypes: { table: "Finance_Enum_TransactionType", sql: "SELECT TransactionType, Name FROM Finance_Enum_TransactionType" },
};

const STAFF_COL = /^(StaffID|DriverID|RaceEngineerID|ChiefDesignerID|CurrentHolder|RivalID|FastestLapDriverID)$/;
function fkSource(table, col) {
  const isEnum = /Enum/.test(table);
  if (/TeamID$/.test(col) && table !== "Teams") return "teams";
  if (STAFF_COL.test(col) && table !== "Staff_BasicData") return "staff";
  if (col === "PartType" && table !== "Parts_Enum_Type") return "parts";
  if (col === "PartStat") return "partStats";
  if ((col === "StatID" && /^(Staff|Scouting)_/.test(table)) || (col === "Stat" && table === "Staff_DriverPerformanceEvaluations_Stats")) return "staffStats";
  if (col === "CountryID" && table !== "Countries") return "countries";
  if (/TrackID$/.test(col) && table !== "Races_Tracks") return "tracks";
  if (col === "BuildingID" && table !== "Buildings") return "buildings";
  if (col === "BuildingType" || (col === "Type" && /^Buildings(_HQ_History)?$/.test(table))) return "buildingTypes";
  if (col === "BuildingState") return "buildingStates";
  if (col === "EffectID" && table === "Buildings_Effects") return "buildingEffects";
  if (col === "ContractType" && !isEnum) return "contractTypes";
  if (col === "StaffType" && !isEnum) return "staffTypes";
  if (col === "DesignSpeed") return "devSpeeds";
  if (col === "DesignType" && !isEnum) return "designTypes";
  if (col === "State" && table === "Races") return "raceStates";
  if (col === "WeekendType" && !isEnum) return "weekendTypes";
  if (/^Staff_Mentality_/.test(table)) {
    if (col === "Category") return "mentalityCats";
    if (col === "Opinion") return "mentality";
    if (col === "Status") return "mentalityStatus";
    if (col === "Event") return "mentalityEvents";
  }
  if (col === "TransactionType" && !isEnum) return "transactionTypes";
  return null;
}

function fkMap(src) {
  S.fkCache = S.fkCache || {};
  if (!S.fkCache[src]) {
    const d = FK_SOURCES[src];
    const m = new Map();
    if (hasTable(d.table)) {
      try {
        for (const [k, v] of q(typeof d.sql === "function" ? d.sql() : d.sql).rows) m.set(k, (d.clean || cleanTeam)(v));
      } catch { /* table de version différente : pas de libellés */ }
    }
    S.fkCache[src] = m;
  }
  return S.fkCache[src];
}
const fkLabel = (src, id) => fkMap(src).get(id);
const L = (src, id) => fkLabel(src, id) ?? id;

const BOOL_COL = /^(Is|Has|Wants|Can)[A-Z]|^(Retired|Unread|Flagged|Selected|Achieved|Completed|Disabled|Served|DNF|SprintShootout|NewDesign|PitLaneStart|Hidden|Visible|TrainingInProgress|AffiliateDualRoleClause|UpkeepAffectsCostCap|AffectsCostCap|ServeInRace|ServeInSprint|CustomTeamEnabled|PitCrewDevelopmentLocked)$/;
const MONEY_COL = /(Cost|Salary|Balance|Budget|Bonus|Fee|PrizePool|Income|Spending|Amount|Payment|Price)$|^SpendingCap$/;
const DATE_COL = col => col === "DOB" || (/Day$/.test(col) && !/(PerDay|WeekDay)$/.test(col));

// Type d'affichage d'une colonne : fk | bool | date | money | null
function colKind(table, col, type) {
  const src = fkSource(table, col);
  if (src && hasTable(FK_SOURCES[src].table)) return { kind: "fk", src };
  if (/INT/i.test(type) && BOOL_COL.test(col)) return { kind: "bool" };
  if (DATE_COL(col) && (/INT/i.test(type) || !type)) return { kind: "date" };
  if ((NUM_TYPE.test(type) && MONEY_COL.test(col)) || (table === "Finance_Transactions" && col === "Value")) return { kind: "money" };
  return null;
}

function moneyShort(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " M$";
  if (a >= 1e4) return (v / 1e3).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k$";
  return fmt(v) + " $";
}
const excelDateStr = n => new Date(Date.UTC(1899, 11, 30) + n * 86400000).toLocaleDateString("fr-FR", { timeZone: "UTC" });
function parseExcelDate(str) {
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return Math.round((Date.UTC(+m[3], +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 86400000);
}

// HTML d'une cellule selon son type
function cellHtml(k, v) {
  if (v === null || v === undefined) return "NULL";
  if (k) {
    if (k.kind === "fk") {
      const l = fkLabel(k.src, v);
      if (l != null) return `${esc(l)} <span class="cid">${esc(v)}</span>`;
    } else if (k.kind === "bool" && (v === 0 || v === 1)) {
      return `<span class="tgl${v ? " on" : ""}"></span>`;
    } else if (k.kind === "date" && typeof v === "number" && v > 20000) {
      return esc(excelDateStr(v));
    } else if (k.kind === "money" && typeof v === "number") {
      return esc(moneyShort(v));
    }
  }
  if (typeof v === "string" && /^\[.*\]$/.test(v)) return esc(cleanLoc(v));
  return esc(fmt(v));
}

/* ---------- grille éditable ---------- */
// o: { table, cols?, extras?: [{label, sql, fmt?}], where?, params?, order?, pageSize?, bulk?, onRowClick?, rowButton?, rowLabel? }
// La grille remplace le contenu de `parent` ; une ancienne grille au même endroit est détachée et oubliée.
class Grid {
  constructor(parent, o) {
    this.el = document.createElement("div");
    parent.replaceChildren(this.el);
    this.o = o;
    this.page = 0;
    this.sort = null;
    S.grids = S.grids.filter(g => g.el.isConnected);
    S.grids.push(this);
    this.el.addEventListener("click", e => this.onClick(e));
    this.render();
  }

  get info() { return tables().get(this.o.table).cols; }

  render() {
    const o = this.o;
    if (!hasTable(o.table)) {
      this.el.innerHTML = `<p class="muted">Table <code>${esc(o.table)}</code> absente de cette save (autre version du jeu ?).</p>`;
      return;
    }
    const info = this.info;
    this.cols = o.cols ? o.cols.filter(n => info.some(i => i.name === n)) : info.map(i => i.name);
    this.extras = o.extras || [];
    this.kinds = this.cols.map(c => colKind(o.table, c, info.find(i => i.name === c).type));
    const where = o.where || "1";
    const params = o.params || [];
    const size = o.pageSize || 200;

    let total;
    try {
      total = q1(`SELECT count(*) FROM ${qi(o.table)} WHERE ${where}`, params);
    } catch (e) {
      this.el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    this.total = total;
    const pages = Math.max(1, Math.ceil(total / size));
    this.page = Math.min(this.page, pages - 1);

    const order = this.sort ? `${qi(this.sort.col)} ${this.sort.desc ? "DESC" : "ASC"}` : o.order || "rowid";
    const select = [
      "rowid AS __rid",
      ...this.extras.map(x => `(${x.sql}) AS ${qi(x.label)}`),
      ...this.cols.map(qi),
    ].join(", ");
    const res = q(`SELECT ${select} FROM ${qi(o.table)} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, size, this.page * size]);
    this.rows = res.rows;

    const numCols = this.cols.filter((c, k) => NUM_TYPE.test(info.find(i => i.name === c).type) && !["fk", "bool", "date"].includes(this.kinds[k]?.kind));
    const head = [
      o.onRowClick ? "<th></th>" : "",
      ...this.extras.map(x => this.th(x.label, "")),
      ...this.cols.map(c => this.th(c, info.find(i => i.name === c).type)),
    ].join("");

    const nx = this.extras.length;
    const body = this.rows.map((r, i) => {
      const rid = r[0];
      const cells = [];
      if (o.onRowClick) cells.push(`<td><button class="small" data-row="${i}">${esc(o.rowButton || "Voir")}</button></td>`);
      for (let k = 0; k < nx; k++) {
        const x = this.extras[k];
        cells.push(`<td class="label">${esc(x.fmt ? x.fmt(r[1 + k]) : fmt(r[1 + k]))}</td>`);
      }
      this.cols.forEach((c, k) => {
        const v = r[1 + nx + k];
        const kd = this.kinds[k];
        const cls = ["edit"];
        if (kd) cls.push(kd.kind);
        else if (typeof v === "number") cls.push("num");
        if (v === null) cls.push("null");
        if (S.edited.has(`${o.table}|${rid}|${c}`)) cls.push("edited");
        if (v instanceof Uint8Array) cls.shift();
        const tip = typeof v === "string" && v.startsWith("[") ? `${c} : ${v}` : kd && v != null ? `${c} = ${v}` : c;
        cells.push(`<td class="${cls.join(" ")}" data-i="${i}" data-col="${esc(c)}" title="${esc(tip)}">${cellHtml(kd, v)}</td>`);
      });
      return `<tr class="${this.selected === rid ? "selected" : ""}">${cells.join("")}</tr>`;
    }).join("");

    const from = total ? this.page * size + 1 : 0;
    const to = Math.min(total, (this.page + 1) * size);
    const pager = pages > 1
      ? `<button class="small" data-pg="-1" ${this.page === 0 ? "disabled" : ""}>◀</button>
         <span>page ${this.page + 1}/${pages}</span>
         <button class="small" data-pg="1" ${this.page >= pages - 1 ? "disabled" : ""}>▶</button>` : "";
    const bulk = o.bulk !== false && numCols.length && total
      ? `<select data-b="col">${numCols.map(c => `<option>${esc(c)}</option>`).join("")}</select>
         <select data-b="op"><option value="mul">× multiplier</option><option value="add">+ ajouter</option><option value="set">= définir</option></select>
         <input class="val" data-b="val" placeholder="valeur">
         <button class="small" data-b="go">Appliquer aux ${total} lignes</button>` : "";

    this.el.innerHTML = `
      <div class="gridtools"><span class="count">${from}–${to} sur ${total} lignes</span>${pager}${bulk}</div>
      <div class="gridwrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  th(name, type) {
    const s = this.sort && this.sort.col === name;
    return `<th data-sort="${esc(name)}" class="${s ? "sorted" + (this.sort.desc ? " desc" : "") : ""}">${esc(name)}${type ? `<span class="type">${esc(type.toLowerCase())}</span>` : ""}</th>`;
  }

  onClick(e) {
    const t = e.target;
    if (t.closest("input")) return;
    const th = t.closest("th[data-sort]");
    if (th) {
      const col = th.dataset.sort;
      this.sort = this.sort && this.sort.col === col ? (this.sort.desc ? null : { col, desc: true }) : { col, desc: false };
      return this.render();
    }
    if (t.dataset.pg) { this.page += +t.dataset.pg; return this.render(); }
    if (t.dataset.b === "go") return this.bulk();
    if (t.dataset.row !== undefined) {
      const r = this.rows[+t.dataset.row];
      this.selected = r[0];
      this.render();
      return this.o.onRowClick(this.rowObject(r));
    }
    const td = t.closest("td.edit");
    if (!td || td.querySelector("input, select")) return;
    if (td.classList.contains("bool")) return this.toggle(td);
    this.startEdit(td);
  }

  rowObject(r) {
    const obj = { rowid: r[0] };
    this.extras.forEach((x, k) => (obj[x.label] = r[1 + k]));
    this.cols.forEach((c, k) => (obj[c] = r[1 + this.extras.length + k]));
    return obj;
  }

  commitCell(row, col, old, v) {
    if (v === undefined || typeof v === "boolean" || (typeof v === "number" && !isFinite(v))) throw new Error(`Valeur invalide pour ${col}`);
    const label = this.o.rowLabel ? ` [${this.o.rowLabel(this.rowObject(row))}]` : ` [rowid ${row[0]}]`;
    const k = this.kinds[this.cols.indexOf(col)];
    const show = x => (k ? cellHtml(k, x).replace(/<[^>]+>/g, "").trim() : fmt(x));
    mutate({
      label: `${this.o.table}.${col}${label} : ${show(old)} → ${show(v)}`,
      table: this.o.table, col, where: "rowid = ?", params: [row[0]], setExpr: "?", setParams: [v],
    });
  }

  toggle(td) {
    const row = this.rows[+td.dataset.i], col = td.dataset.col;
    const old = row[1 + this.extras.length + this.cols.indexOf(col)];
    if (old !== 0 && old !== 1) return this.startEdit(td);
    this.commitCell(row, col, old, old ? 0 : 1);
    refreshAll();
  }

  // Liste déroulante pour les colonnes qui référencent une autre table
  startSelect(td, row, col, old, src) {
    const sel = document.createElement("select");
    const opts = [...fkMap(src)].sort((a, b) => (src === "teams" ? a[0] - b[0] : String(a[1]).localeCompare(String(b[1]))));
    if (old != null && !fkMap(src).has(old)) opts.unshift([old, "?"]);
    sel.innerHTML = (old === null ? '<option value="">NULL</option>' : "") +
      opts.map(([id, l]) => `<option value="${esc(id)}" ${id === old ? "selected" : ""}>${esc(l)} (${esc(id)})</option>`).join("");
    td.textContent = "";
    td.appendChild(sel);
    sel.focus();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save && sel.value !== String(old)) {
        const v = typeof old === "string" ? sel.value : Number(sel.value);
        try { this.commitCell(row, col, old, v); } catch (e) { toast(e.message, true); }
      }
      refreshAll();
    };
    sel.addEventListener("change", () => finish(true));
    sel.addEventListener("keydown", e => { if (e.key === "Escape") finish(false); });
    sel.addEventListener("blur", () => finish(false));
  }

  startEdit(td) {
    const i = +td.dataset.i, col = td.dataset.col;
    const row = this.rows[i];
    const old = row[1 + this.extras.length + this.cols.indexOf(col)];
    const kd = this.kinds[this.cols.indexOf(col)];
    if (kd && kd.kind === "fk") return this.startSelect(td, row, col, old, kd.src);
    const isDate = kd && kd.kind === "date" && typeof old === "number" && old > 20000;
    const input = document.createElement("input");
    const initial = old === null ? "NULL" : isDate ? excelDateStr(old) : String(old);
    input.value = initial;
    if (typeof old === "string") input.style.textAlign = "left";
    if (isDate) input.title = "JJ/MM/AAAA ou nombre de jours";
    if (kd && kd.kind === "money") input.title = "Accepte 250k ou 1,5M";
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save, next) => {
      if (done) return;
      done = true;
      if (save && input.value !== initial) {
        try {
          const v = (isDate ? parseExcelDate(input.value) : null) ?? parseInput(input.value, old);
          this.commitCell(row, col, old, v);
        } catch (e) {
          toast(e.message, true);
        }
      }
      refreshAll();
      if (next) {
        const k = this.cols.indexOf(col) + next;
        const target = this.cols[k] && this.el.querySelector(`td[data-i="${i}"][data-col="${CSS.escape(this.cols[k])}"]`);
        if (target && target.classList.contains("edit")) this.startEdit(target);
      }
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      else if (e.key === "Tab") { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  bulk() {
    const get = k => this.el.querySelector(`[data-b="${k}"]`).value;
    const col = get("col"), op = get("op");
    const val = Number(get("val").replace(",", "."));
    if (get("val").trim() === "" || !isFinite(val)) return toast("Entre une valeur numérique", true);
    const isInt = /INT/i.test(this.info.find(i => i.name === col).type);
    let expr = { mul: `${qi(col)} * ?`, add: `${qi(col)} + ?`, set: "?" }[op];
    if (isInt && op !== "set") expr = `CAST(ROUND(${expr}) AS INTEGER)`;
    const sym = { mul: "×", add: "+", set: "=" }[op];
    if (!confirm(`${this.o.table}.${col} ${sym} ${val} sur ${this.total} lignes ?`)) return;
    const n = mutate({
      label: `${this.o.table}.${col} ${sym} ${val} sur ${this.total} lignes${this.o.where ? ` (WHERE ${this.o.where} ${JSON.stringify(this.o.params || [])})` : ""}`,
      table: this.o.table, col, where: this.o.where || "1", params: this.o.params || [],
      setExpr: expr, setParams: op === "set" ? [isInt ? Math.round(val) : val] : [val],
    });
    toast(`${n} lignes modifiées`);
    refreshAll();
  }
}

/* ---------- chargement / sauvegarde ---------- */
async function loadBytes(u8, name, handle) {
  await sqlReady;
  if (!S.SQL) return;
  let save;
  try {
    save = F1Save.parseSave(u8, pako.inflate);
  } catch (e) {
    return toast(e.message, true);
  }
  if (S.db) S.db.close();
  Object.assign(S, {
    db: new S.SQL.Database(save.dbs[0]), save, fileName: name, handle: handle || null, origBytes: u8,
    undo: [], journal: [], edited: new Set(), backupDone: false, grids: [], tableCache: null, fkCache: null, perfConv: null,
  });
  try { S.playerTeam = q1("SELECT TeamID FROM Player"); } catch { S.playerTeam = null; }
  document.body.classList.remove("empty");
  log(`Ouverture de ${name} (${save.game})`);
  setDirty(false);
  renderAll();
  toast(`${name} chargée — ${save.game}`);
}

async function openFile() {
  if (S.dirty && !confirm("Des modifications non enregistrées seront perdues. Continuer ?")) return;
  if (window.showOpenFilePicker) {
    try {
      const [h] = await showOpenFilePicker({ types: [{ description: "Save F1 Manager", accept: { "application/octet-stream": [".sav"] } }] });
      const f = await h.getFile();
      return loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, h);
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  $("#fileInput").click();
}

function exportSave() {
  S.db.run("VACUUM");
  const main = S.db.export();
  return F1Save.buildSave(S.save.header, [main, S.save.dbs[1], S.save.dbs[2]], d => pako.deflate(d, { level: 9 }), S.save.trailing);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const baseName = () => S.fileName.replace(/\.sav$/i, "");

async function save() {
  if (!S.handle || !S.handle.createWritable) return saveAs();
  if (!S.backupDone) {
    if (!confirm(`Écraser ${S.fileName} ?\nUne copie de la version d'origine va être téléchargée par sécurité (${baseName()}.backup-${stamp()}.sav).`)) return;
  }
  try {
    if ((await S.handle.requestPermission({ mode: "readwrite" })) !== "granted") return toast("Permission d'écriture refusée", true);
    const bytes = exportSave();
    if (!S.backupDone) { download(S.origBytes, `${baseName()}.backup-${stamp()}.sav`); S.backupDone = true; }
    const w = await S.handle.createWritable();
    await w.write(bytes);
    await w.close();
    log(`Enregistré dans ${S.fileName} (${(bytes.length / 1e6).toFixed(2)} Mo)`);
    setDirty(false);
    toast(`${S.fileName} enregistrée`);
  } catch (e) {
    toast("Erreur d'enregistrement : " + e.message, true);
  }
}

async function saveAs() {
  const bytes = exportSave();
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: S.fileName, types: [{ description: "Save F1 Manager", accept: { "application/octet-stream": [".sav"] } }] });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
      S.handle = h;
      S.fileName = h.name;
      S.backupDone = true;
      log(`Enregistré sous ${h.name}`);
      setDirty(false);
      return toast(`${h.name} enregistrée`);
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  download(bytes, S.fileName);
  log(`Téléchargé : ${S.fileName}`);
  setDirty(false);
}

/* ---------- rendu ---------- */
function renderAll() {
  renderDev();
  renderPerf();
  renderStaff();
  renderTeam();
  renderBuildings();
  renderRules();
  renderTableList();
  $("#tableView").innerHTML = '<p class="muted">Choisis une table à gauche.</p>';
  renderRepack();
  renderJournal();
}

function renderFileInfo() {
  const el = $("#fileinfo");
  const on = !!S.db;
  ["#btnSave", "#btnSaveAs"].forEach(b => ($(b).disabled = !on));
  if (!on) return;
  el.innerHTML = `<b>${esc(S.fileName)}</b> · ${esc(S.save.game)} ${S.dirty ? '· <span class="dirty">● modifié</span>' : ""}`;
  $("#btnSave").textContent = S.handle && S.handle.createWritable ? "Enregistrer" : "Télécharger .sav";
}

function renderJournal() {
  $("#journalCount").textContent = S.journal.length;
  $("#journal").innerHTML = S.journal.slice().reverse()
    .map(j => `<li><span class="muted">${j.time.toLocaleTimeString("fr-FR")}</span> ${esc(j.text)}</li>`).join("");
}

function card(parent, title, hint) {
  const c = document.createElement("div");
  c.className = "card";
  c.innerHTML = `<div class="row spread"><h2>${esc(title)}</h2></div>${hint ? `<p class="hint">${hint}</p>` : ""}<div class="body"></div>`;
  parent.appendChild(c);
  return c;
}

// Carte contenant une grille ; renvoie la carte
function gridCard(parent, title, hint, opts) {
  const c = card(parent, title, hint);
  new Grid(c.querySelector(".body"), opts);
  return c;
}

function grid2(parent) {
  const d = document.createElement("div");
  d.className = "grid2";
  parent.appendChild(d);
  return d;
}

// Nettoie les clés de localisation : [StaffName_Surname_Leclerc] → Leclerc, [STRING_LITERAL:Value=|Ella|] → Ella
function cleanLoc(s) {
  return String(s ?? "")
    .replace(/^\[STRING_LITERAL:Value=\|(.*)\|\]$/, "$1")
    .replace(/^\[(StaffName_(Forename_(Male|Female)_|Surname_)|TeamName_(F\d_)?|Building_)/, "")
    .replace(/\]$/, "")
    .replace(/_/g, " ");
}
const cleanTeam = s => cleanLoc(s).replace(/([a-z])([A-Z])/g, "$1 $2");
const cleanName = s => String(s ?? "").split("|").map(cleanLoc).join(" ");

function teamNameSql(ref) {
  if (!hasTable("Teams")) return "NULL";
  const hasName = tables().get("Teams").cols.some(c => c.name === "TeamName");
  return `(SELECT ${hasName ? "COALESCE(NULLIF(TeamName,''), TeamNameLocKey)" : "TeamNameLocKey"} FROM Teams tt WHERE tt.TeamID = ${ref})`;
}
const TEAM = ref => ({ label: "Équipe", sql: teamNameSql(ref), fmt: cleanTeam });
const STAFF_NAME = ref => ({ label: "Nom", sql: `(SELECT FirstName || '|' || LastName FROM Staff_BasicData b WHERE b.StaffID = ${ref})`, fmt: cleanName });
const ENUM = (label, table, key, ref) => ({ label, sql: `(SELECT Name FROM ${table} x WHERE x.${key} = ${ref})` });

function teamOptions(selected, withAll) {
  if (!hasTable("Teams")) return "";
  const cols = tables().get("Teams").cols.map(c => c.name);
  const where = cols.includes("Formula") ? "WHERE Formula = 1 OR TeamID = ?" : "WHERE ? IS NOT NULL";
  const opts = q(`SELECT TeamID, ${teamNameSql("Teams.TeamID")} FROM Teams ${where} ORDER BY TeamID`, [selected ?? -1]).rows
    .map(([id, n]) => `<option value="${id}" ${id === selected ? "selected" : ""}>${id} · ${esc(cleanTeam(n))}${id === S.playerTeam ? " (toi)" : ""}</option>`);
  return (withAll ? `<option value="" ${selected == null ? "selected" : ""}>Toutes les équipes</option>` : "") + opts.join("");
}

// Ajoute un sélecteur d'équipe dans l'en-tête d'une carte et appelle onChange(teamId|null) tout de suite
function teamPicker(c, onChange, { withAll = false, initial = S.playerTeam } = {}) {
  const sel = document.createElement("select");
  sel.innerHTML = teamOptions(initial, withAll);
  const label = document.createElement("label");
  label.append("Équipe ", sel);
  c.querySelector(".row").appendChild(label);
  const fire = () => onChange(sel.value === "" ? null : +sel.value);
  sel.addEventListener("change", fire);
  fire();
  return sel;
}

// Bouton d'action dans l'en-tête d'une carte
function headerButton(c, text, onClick, cls = "small") {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", onClick);
  c.querySelector(".row").appendChild(b);
  return b;
}

const PART = t => `(SELECT Name FROM Parts_Enum_Type e WHERE e.Value = ${t}.PartType)`;
const STAT = t => `(SELECT Name FROM Parts_Enum_Stats s WHERE s.Value = ${t}.PartStat)`;
const currentSeason = () => { try { return q1("SELECT CurrentSeason FROM Player_State"); } catch { return null; } };

/* ---------- page Développement ---------- */
function renderDev() {
  const root = $("#tab-dev");
  root.innerHTML = "";
  const top = grid2(root);

  gridCard(top, "Coût de développement par pièce",
    "<code>Parts_Enum_Type</code> — coût et charge de travail <b>de base</b> d'un design, avant le multiplicateur de vitesse. S'applique aux <b>nouveaux</b> projets (les designs déjà lancés gardent leur coût).",
    {
      table: "Parts_Enum_Type", rowLabel: r => r.Name,
      cols: ["Value", "Name", "BaseDesignCost", "BaseManufactureCost", "BaseDesignWork", "BaseManufactureWork", "PreSeasonDesignCostMultiplier", "PreSeasonBuildCostMultiplier"],
    });

  gridCard(top, "Vitesses de développement",
    "<code>Parts_Enum_DevSpeeds</code> — <b>CostMultiplier</b> × coût de base = prix du design. <b>ExpertisePerDay</b> = expertise gagnée par jour de dev. <b>SpeedMultiplier</b> = vitesse d'avancement.",
    { table: "Parts_Enum_DevSpeeds", rowLabel: r => r.Name });

  const c = card(top, "Prix d'un design (calculé)", "BaseDesignCost × CostMultiplier, mis à jour en direct quand tu modifies les deux tableaux ci-dessus.");
  const matrix = { el: c.querySelector(".body"), render() { renderCostMatrix(this.el); } };
  S.grids.push(matrix);
  matrix.render();

  gridCard(top, "Gain d'expertise de l'IA", "<code>Difficulty_TeamManagement</code> — expertise gagnée par les équipes IA sur leurs designs.",
    { table: "Difficulty_TeamManagement", bulk: false });

  const teamCard = card(root, "Expertise et designs d'une équipe", "");
  const body = teamCard.querySelector(".body");
  body.innerHTML = `
    <h3>Expertise actuelle <span class="muted">— Parts_TeamExpertise</span></h3>
    <p class="hint"><b>Expertise</b> = niveau actuel de la stat, <b>NextSeasonExpertise</b> = bonus appliqué à la saison suivante. « × multiplier » sur toute la colonne pour un boost global.</p>
    <div class="exp"></div>
    <h3 style="margin-top:18px">Designs <span class="muted">— Parts_Designs (DesignCost = prix payé, DesignWork / DesignWorkMax = avancement)</span></h3>
    <div class="designs"></div>
    <div class="stats"></div>`;

  teamPicker(teamCard, teamId => {
    $(".stats", body).innerHTML = "";
    new Grid($(".exp", body), {
      table: "Parts_TeamExpertise", where: "TeamID = ?", params: [teamId], order: "PartType, PartStat",
      cols: ["PartType", "PartStat", "Expertise", "NextSeasonExpertise", "SeasonStartExpertise"],
      rowLabel: r => `${L("teams", teamId)} ${L("parts", r.PartType)} ${L("partStats", r.PartStat)}`,
    });
    new Grid($(".designs", body), {
      table: "Parts_Designs", where: "TeamID = ?", params: [teamId], order: "DesignID DESC", pageSize: 30,
      cols: ["DesignID", "PartType", "DesignNumber", "DesignWork", "DesignWorkMax", "DesignCost", "BuildCost", "BuildWorkMax", "DesignSpeed", "ValidFrom", "DayCreated", "DayCompleted", "ManufactureCount", "PartKnowledge"],
      rowLabel: r => `design ${r.DesignID} ${L("parts", r.PartType)}`,
      rowButton: "Stats",
      onRowClick: r => {
        const st = $(".stats", body);
        st.innerHTML = `<h3 style="margin-top:18px">Stats du design ${r.DesignID} (${esc(L("parts", r.PartType))}) <span class="muted">— Parts_Designs_StatValues · ExpertiseGain = expertise débloquée par ce design</span></h3><div></div>`;
        new Grid(st.lastElementChild, {
          table: "Parts_Designs_StatValues", where: "DesignID = ?", params: [r.DesignID], order: "PartStat",
          rowLabel: s => `design ${r.DesignID} ${L("partStats", s.PartStat)}`,
        });
      },
    });
  });
}

function renderCostMatrix(el) {
  if (!hasTable("Parts_Enum_Type") || !hasTable("Parts_Enum_DevSpeeds")) {
    el.innerHTML = '<p class="muted">Tables absentes.</p>';
    return;
  }
  const speeds = q("SELECT Value, Name, CostMultiplier FROM Parts_Enum_DevSpeeds ORDER BY Value").rows;
  const partsRes = q("SELECT Name, BaseDesignCost FROM Parts_Enum_Type ORDER BY Value").rows;
  el.innerHTML = `<div class="gridwrap"><table class="grid"><thead><tr><th>Pièce</th>${speeds.map(s => `<th>${esc(s[1])} <span class="type">×${fmt(s[2])}</span></th>`).join("")}</tr></thead>
    <tbody>${partsRes.map(([n, base]) => `<tr><td>${esc(n)}</td>${speeds.map(s => `<td class="num">${money(base * s[2])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/* ---------- page Staff & pilotes ---------- */
function renderStaff() {
  const root = $("#tab-staff");
  root.innerHTML = "";
  const list = card(root, "Staff et pilotes",
    "Liste par équipe (contrats en cours) ou recherche par nom dans tout le jeu. Clique sur <b>Éditer</b> pour les stats, le contrat, l'XP et le moral.");
  list.querySelector(".row").insertAdjacentHTML("beforeend", `<input type="search" class="staffSearch" placeholder="Nom (ex: Leclerc)">`);
  const detail = document.createElement("div");
  root.appendChild(detail);

  const search = $(".staffSearch", list);
  let team = S.playerTeam;
  const show = () => {
    const where = [], params = [];
    if (team != null) { where.push("StaffID IN (SELECT StaffID FROM Staff_Contracts WHERE TeamID = ? AND ContractType = 0)"); params.push(team); }
    const s = search.value.trim();
    if (s) { where.push("StaffID IN (SELECT StaffID FROM Staff_BasicData WHERE FirstName || ' ' || LastName LIKE ?)"); params.push(`%${s.replace(/\s+/g, "%")}%`); }
    new Grid(list.querySelector(".body"), {
      table: "Staff_GameData", where: where.join(" AND ") || undefined, params, order: "StaffType, StaffID", pageSize: 100,
      extras: [
        TEAM("(SELECT TeamID FROM Staff_Contracts c WHERE c.StaffID = Staff_GameData.StaffID AND c.ContractType = 0 LIMIT 1)"),
        { label: "Âge", sql: "(SELECT CAST(((SELECT Day FROM Player_State) - b.DOB) / 365.25 AS INTEGER) FROM Staff_BasicData b WHERE b.StaffID = Staff_GameData.StaffID)" },
        { label: "Overall", sql: "(SELECT ROUND(AVG(Val)) FROM Staff_PerformanceStats p WHERE p.StaffID = Staff_GameData.StaffID)" },
      ],
      cols: ["StaffID", "StaffType", "RetirementAge", "Retired"],
      rowLabel: r => L("staff", r.StaffID),
      rowButton: "Éditer",
      onRowClick: r => showStaff(detail, r.StaffID, L("staff", r.StaffID)),
    });
  };
  teamPicker(list, t => { team = t; show(); }, { withAll: true });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(show, 250); });
}

function showStaff(detail, id, name) {
  const label = String(name ?? id);
  detail.innerHTML = `<div class="sc-host"></div>
    <details class="card raw"><summary>Tables brutes (avancé) : contrats, stats, état, données pilote</summary><div class="rawbody"></div></details>`;
  new StaffCard($(".sc-host", detail), id);

  const raw = $(".rawbody", detail);
  gridCard(raw, "Contrats", "<code>Staff_Contracts</code> — ContractType 0 = contrat en cours, 3 = futur. EndSeason = dernière saison du contrat, PosInTeam 1/2 = pilote titulaire, 3 = réserve.", {
    table: "Staff_Contracts", where: "StaffID = ?", params: [id], bulk: false,
    rowLabel: r => `${label} ${L("contractTypes", r.ContractType)}`,
  });
  gridCard(raw, "Stats", "<code>Staff_PerformanceStats</code> — Val = niveau actuel, Max = potentiel.", {
    table: "Staff_PerformanceStats", where: "StaffID = ?", params: [id], order: "StatID",
    rowLabel: r => `${label} ${L("staffStats", r.StatID)}`,
  });
  gridCard(raw, "État", "<code>Staff_State</code> — XP non dépensée et moral.", {
    table: "Staff_State", where: "StaffID = ?", params: [id], bulk: false, rowLabel: () => label,
  });
  if (q1("SELECT count(*) FROM Staff_DriverData WHERE StaffID = ?", [id])) {
    gridCard(raw, "Données pilote", "<code>Staff_DriverData</code>", {
      table: "Staff_DriverData", where: "StaffID = ?", params: [id], bulk: false, rowLabel: () => label,
    });
  }
  gridCard(raw, "Infos", "<code>Staff_GameData</code>", {
    table: "Staff_GameData", where: "StaffID = ?", params: [id], bulk: false, rowLabel: () => label,
  });
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- fiche staff / pilote ---------- */
// Libellés du jeu (le stat 9 « Acceleration » s'appelle « Reactions » en jeu)
const DRIVER_STATS = { 2: ["Cornering", "COR"], 3: ["Braking", "BRA"], 4: ["Control", "CON"], 5: ["Smoothness", "SMO"], 6: ["Adaptability", "ADA"], 7: ["Overtaking", "OVE"], 8: ["Defence", "DEF"], 9: ["Reactions", "REA"], 10: ["Accuracy", "ACC"] };
// Pondération de l'overall pilote (même formule que f1dbeditor ; somme des poids = 5)
const OVR_WEIGHTS = { 2: 1, 3: 0.75, 4: 0.75, 5: 0.5, 6: 0.25, 7: 0.25, 8: 0.25, 9: 0.5, 10: 0.75 };
// Moral : Opinion 0 (optimiste) → 4 (pessimiste) ; statuts et événements liés à chaque domaine (repris de f1dbeditor)
const MOOD_LABELS = ["Optimiste", "Positif", "Neutre", "Négatif", "Pessimiste"];
const MOOD_AREAS = ["Situation perso", "Performance de l'équipe", "Team principal"];
const MOOD_STATUSES = { 0: [5, 11, 13, 9], 1: [0, 2, 6, 7, 8, 14], 2: [1, 3, 4, 12, 10] };
const MOOD_EVENTS = { 0: [1, 7, 10, 13, 15, 19], 1: [2, 11, 12, 14, 16, 20, 21], 2: [0, 3, 4, 5, 6, 8, 9, 17, 18] };
const MOOD_VALUE = [10, 3, 0, -4, -10];
const MOOD_OVERALL = [95, 79, 59, 24, 5];

const excelToDate = n => new Date(Date.UTC(1899, 11, 30) + n * 86400000);
const dateToExcel = d => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400000);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class StaffCard {
  constructor(parent, id) {
    this.el = document.createElement("div");
    this.el.className = "card staffcard";
    parent.replaceChildren(this.el);
    this.id = id;
    S.grids = S.grids.filter(g => g.el.isConnected);
    S.grids.push(this);
    this.el.addEventListener("click", e => this.onClick(e));
    this.el.addEventListener("change", e => this.onChange(e));
    this.render();
  }

  load() {
    const id = this.id;
    const one = (sql, p = [id]) => { const r = q(sql, p); return r.rows[0] ? Object.fromEntries(r.cols.map((c, i) => [c, r.rows[0][i]])) : null; };
    const d = {};
    d.basic = one("SELECT FirstName, LastName, CountryID, DOB FROM Staff_BasicData WHERE StaffID = ?") || {};
    d.game = one("SELECT StaffType, RetirementAge, Retired FROM Staff_GameData WHERE StaffID = ?") || {};
    d.role = q1("SELECT Name FROM Staff_Enum_StaffType WHERE StaffType = ?", [d.game.StaffType]);
    d.country = hasTable("Countries") ? q1("SELECT COALESCE(EnumName, Name) FROM Countries WHERE CountryID = ?", [d.basic.CountryID]) : null;
    d.contract = one("SELECT TeamID, PosInTeam, Salary, EndSeason FROM Staff_Contracts WHERE StaffID = ? AND ContractType = 0 LIMIT 1");
    d.team = d.contract ? q1(`SELECT ${teamNameSql("?")}`, [d.contract.TeamID]) : null;
    d.driver = one("SELECT * FROM Staff_DriverData WHERE StaffID = ?");
    d.number = d.driver && hasTable("Staff_DriverNumbers") ? q1("SELECT Number FROM Staff_DriverNumbers WHERE CurrentHolder = ?", [id]) : null;
    d.stats = q(`SELECT p.StatID, p.Val, p.Max, (SELECT Name FROM Staff_Enum_PerformanceStatTypes t WHERE t.Value = p.StatID)
                 FROM Staff_PerformanceStats p WHERE p.StaffID = ? ORDER BY p.StatID`, [id]).rows;
    d.mood = hasTable("Staff_Mentality_AreaOpinions") ? q("SELECT Category, Opinion FROM Staff_Mentality_AreaOpinions WHERE StaffID = ? ORDER BY Category", [id]).rows : [];
    d.state = one("SELECT UnspentXP, Mentality FROM Staff_State WHERE StaffID = ?");
    d.day = q1("SELECT Day FROM Player_State");
    d.age = d.basic.DOB != null && d.day != null ? Math.floor((d.day - d.basic.DOB) / 365.25) : null;
    return d;
  }

  overall(d) {
    if (d.driver && d.stats.length === 9 && d.stats.every(s => OVR_WEIGHTS[s[0]] != null))
      return Math.round(d.stats.reduce((a, s) => a + s[1] * OVR_WEIGHTS[s[0]], 0) / 5);
    return d.stats.length ? Math.round(d.stats.reduce((a, s) => a + s[1], 0) / d.stats.length) : null;
  }

  render() {
    const d = (this.d = this.load());
    const name = `${cleanLoc(d.basic.FirstName)} ${cleanLoc(d.basic.LastName)}`;
    this.name = name;
    const dr = d.driver;
    const code = dr ? cleanLoc(dr.DriverCode) : "";
    const pm = (act, extra = "") => `<button class="pm" data-act="${act}" data-d="-1" ${extra}>−</button>`;
    const pp = (act, extra = "") => `<button class="pm" data-act="${act}" data-d="1" ${extra}>+</button>`;
    const toggle = (act, on, text) => `<label class="tg"><input type="checkbox" data-act="${act}" ${on ? "checked" : ""}><span></span>${text}</label>`;

    const head = `
      <div class="sc-head">
        <div class="sc-id">
          <div class="sc-name">${esc(name)}${dr ? `<span class="sep"></span><input class="sc-code" data-act="code" maxlength="3" value="${esc(code)}" title="Code pilote (3 lettres)">` : ""}</div>
          <div class="sc-sub">${esc(d.country ? cleanTeam(d.country) : "—")}<span class="sep"></span>${esc(d.team ? cleanTeam(d.team) : "Sans équipe")}<span class="sep"></span>${esc(cleanTeam(d.role || ""))}${d.contract ? ` · siège ${d.contract.PosInTeam} · ${money(d.contract.Salary)}/an jusqu'en ${d.contract.EndSeason}` : ""}</div>
        </div>
        <div class="sc-block"><h4>Détails</h4>
          <div><b>Âge</b> ${d.age ?? "?"} ans ${d.basic.DOB != null ? pm("age") + pp("age") : ""}</div>
          <div><b>Retraite</b> ${d.game.RetirementAge ?? "?"} ans ${pm("ret")}${pp("ret")}</div>
        </div>
        ${dr ? `<div class="sc-block"><h4>Numéro</h4>
          <div><input class="sc-num" type="number" min="1" max="99" data-act="num" value="${d.number ?? ""}" placeholder="—"></div>
          ${toggle("wants1", dr.WantsChampionDriverNumber, "#1 si champion")}
        </div>` : ""}
        <div class="sc-block"><h4>Disponibilité</h4>
          ${dr ? toggle("sl", dr.HasSuperLicense, "Super licence") : ""}
          ${toggle("retired", d.game.Retired, "Retraité")}
        </div>
        <div class="sc-block sc-ovr"><h4>Overall</h4><div class="big">${this.overall(d) ?? "—"}</div></div>
      </div>`;

    const statRow = (act, key, label, val, max) => `
      <div class="sc-stat">
        <div class="sc-line"><span>${esc(label)}</span><span class="sc-val">${pm(act, `data-k="${key}"`)}<input type="number" data-act="${act}-set" data-k="${key}" value="${Math.round(val)}">${pp(act, `data-k="${key}"`)}</span></div>
        <div class="bar"><i style="width:${clamp(val, 0, 100)}%"></i>${max != null && max < 100 ? `<em style="left:${clamp(max, 0, 100)}%" title="Potentiel max ${max}"></em>` : ""}</div>
        ${max != null ? `<div class="sc-max">potentiel <input type="number" data-act="max-set" data-k="${key}" value="${max}"></div>` : ""}
      </div>`;

    const attrs = d.stats.map(([sid, val, max, n]) => statRow("stat", sid, dr && DRIVER_STATS[sid] ? DRIVER_STATS[sid][0] : cleanTeam(n) || `Stat ${sid}`, val, max)).join("");
    const others = dr ? [
      ["Improvability", "Progression (Growth)"], ["Aggression", "Agressivité"], ["Marketability", "Marketability"],
    ].filter(([c]) => c in dr).map(([c, l]) => statRow("drv", c, l, dr[c] ?? 0, null)).join("") : "";

    const mood = d.mood.length ? `<div class="sc-grid3">${d.mood.map(([cat, op]) => `
      <div class="sc-stat">
        <div class="sc-line"><span>${esc(MOOD_AREAS[cat] || `Domaine ${cat}`)}</span><span class="mood m${op}">${esc(MOOD_LABELS[op] ?? op)}</span></div>
        <div class="segs"><button class="arrow" data-act="mood" data-k="${cat}" data-v="${Math.min(4, op + 1)}">‹</button>
          ${[4, 3, 2, 1, 0].map(v => `<button class="seg ${v >= op ? "on m" + op : ""}" data-act="mood" data-k="${cat}" data-v="${v}" title="${MOOD_LABELS[v]}"></button>`).join("")}
          <button class="arrow" data-act="mood" data-k="${cat}" data-v="${Math.max(0, op - 1)}">›</button></div>
      </div>`).join("")}</div>` : "";

    this.el.innerHTML = `${head}
      <div class="sc-body">
        <div class="sc-main">
          <div class="sc-title"><h3>Attributs</h3>
            <span class="sc-tools">Tout à <input type="number" class="allv" value="99" min="0" max="100"><button class="small" data-act="all">Appliquer</button>
            ${d.state ? `<span class="muted">· XP non dépensée</span> <input type="number" data-act="xp" value="${d.state.UnspentXP}">` : ""}</span></div>
          <div class="sc-grid3">${attrs || '<p class="muted">Aucune stat.</p>'}</div>
          ${others ? `<h3>Autres attributs</h3><div class="sc-grid3">${others}</div>` : ""}
          ${mood ? `<h3>Moral <span class="muted">${d.state ? `(global ${d.state.Mentality})` : ""}</span></h3>${mood}` : ""}
        </div>
        ${dr && d.stats.length >= 3 ? `<div class="sc-radar">${this.radar(d.stats)}</div>` : ""}
      </div>`;
  }

  radar(stats) {
    const S0 = 110, R = 80, n = stats.length;
    const pt = (i, r) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [S0 + r * Math.cos(a), S0 + r * Math.sin(a)];
    };
    const ring = f => stats.map((_, i) => pt(i, R * f).join(",")).join(" ");
    const poly = stats.map(([, v], i) => pt(i, (R * clamp(v, 0, 100)) / 100).join(",")).join(" ");
    return `<svg viewBox="0 0 220 220" role="img" aria-label="Radar des attributs">
      ${[0.25, 0.5, 0.75, 1].map(f => `<polygon points="${ring(f)}" class="rg"/>`).join("")}
      ${stats.map((_, i) => `<line x1="${S0}" y1="${S0}" x2="${pt(i, R)[0]}" y2="${pt(i, R)[1]}" class="rg"/>`).join("")}
      <polygon points="${poly}" class="rv"/>
      ${stats.map(([, v], i) => `<circle cx="${pt(i, (R * clamp(v, 0, 100)) / 100)[0]}" cy="${pt(i, (R * clamp(v, 0, 100)) / 100)[1]}" r="2.5" class="rd"/>`).join("")}
      ${stats.map(([sid, , , n], i) => { const [x, y] = pt(i, R + 16); return `<text x="${x}" y="${y}">${esc((DRIVER_STATS[sid] || [])[1] || String(n || sid).slice(0, 3).toUpperCase())}</text>`; }).join("")}
    </svg>`;
  }

  /* --- actions --- */
  setStat(sid, v) {
    const s = this.d.stats.find(x => x[0] === sid);
    if (!s) return;
    v = clamp(Math.round(v), 0, 100);
    if (v === s[1]) return;
    const statName = (DRIVER_STATS[sid] || [])[0] || s[3];
    batch(`${this.name} ${statName} : ${fmt(s[1])} → ${v}`, () => {
      setValue("Staff_PerformanceStats", "Val", "StaffID = ? AND StatID = ?", [this.id, sid], v);
      if (s[2] != null && v > s[2]) setValue("Staff_PerformanceStats", "Max", "StaffID = ? AND StatID = ?", [this.id, sid], v);
    });
  }

  setAge(delta) {
    const dob = this.d.basic.DOB;
    const old = excelToDate(dob);
    const nd = new Date(Date.UTC(old.getUTCFullYear() - delta, old.getUTCMonth(), old.getUTCDate()));
    if (nd.getUTCMonth() !== old.getUTCMonth()) nd.setUTCDate(0); // 29 février → 28
    const iso = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
    batch(`${this.name} âge ${delta > 0 ? "+" : ""}${delta} an`, () => {
      setValue("Staff_BasicData", "DOB", "StaffID = ?", [this.id], dateToExcel(nd));
      setValue("Staff_BasicData", "DOB_ISO", "StaffID = ?", [this.id], iso);
    });
  }

  setNumber(n) {
    const exists = q1("SELECT count(*) FROM Staff_DriverNumbers WHERE Number = ?", [n]);
    if (!exists) return toast(`Le numéro ${n} n'existe pas dans le jeu`, true);
    const mine = this.d.number;
    if (n === mine) return;
    const holder = q1("SELECT CurrentHolder FROM Staff_DriverNumbers WHERE Number = ?", [n]);
    batch(`${this.name} numéro ${mine ?? "—"} → ${n}${holder ? ` (échange avec StaffID ${holder})` : ""}`, () => {
      if (mine != null) setValue("Staff_DriverNumbers", "CurrentHolder", "Number = ?", [mine], holder ?? null);
      setValue("Staff_DriverNumbers", "CurrentHolder", "Number = ?", [n], this.id);
    });
  }

  setMood(cat, v) {
    const cur = this.d.mood.map(([c, o]) => (c === cat ? v : o));
    if (this.d.mood.find(([c]) => c === cat)[1] === v) return;
    const avg = Math.floor(cur.reduce((a, b) => a + b, 0) / cur.length);
    batch(`${this.name} moral « ${MOOD_AREAS[cat]} » → ${MOOD_LABELS[v]}`, () => {
      setValue("Staff_Mentality_AreaOpinions", "Opinion", "StaffID = ? AND Category = ?", [this.id, cat], v);
      for (const [table, col, ids] of [["Staff_Mentality_Statuses", "Status", MOOD_STATUSES[cat]], ["Staff_Mentality_Events", "Event", MOOD_EVENTS[cat]]]) {
        if (!hasTable(table)) continue;
        const where = `StaffID = ? AND ${col} IN (${ids.join(",")})`;
        setValue(table, "Opinion", where, [this.id], v);
        setValue(table, "Value", where, [this.id], MOOD_VALUE[v]);
      }
      setValue("Staff_State", "Mentality", "StaffID = ?", [this.id], MOOD_OVERALL[avg]);
      setValue("Staff_State", "MentalityOpinion", "StaffID = ?", [this.id], avg);
    });
  }

  run(fn) {
    try { fn(); } catch (e) { toast(e.message, true); }
    refreshAll();
  }

  onClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.dataset.act, d = +b.dataset.d, k = b.dataset.k;
    this.run(() => {
      switch (act) {
        case "stat": return this.setStat(+k, this.d.stats.find(s => s[0] === +k)[1] + d);
        case "drv": {
          const old = this.d.driver[k] ?? 0;
          const v = clamp(Math.round(old) + d, 0, 100);
          return setValue("Staff_DriverData", k, "StaffID = ?", [this.id], v, `${this.name} ${k} : ${fmt(old)} → ${v}`);
        }
        case "age": return this.setAge(d);
        case "ret": {
          const v = (this.d.game.RetirementAge ?? 0) + d;
          return setValue("Staff_GameData", "RetirementAge", "StaffID = ?", [this.id], v, `${this.name} retraite → ${v} ans`);
        }
        case "mood": return this.setMood(+k, +b.dataset.v);
        case "all": {
          const v = clamp(+$(".allv", this.el).value, 0, 100);
          return batch(`${this.name} toutes les stats → ${v}`, () => {
            setValue("Staff_PerformanceStats", "Val", "StaffID = ?", [this.id], v);
            mutate({ table: "Staff_PerformanceStats", col: "Max", where: "StaffID = ? AND Max < ?", params: [this.id, v], setExpr: "?", setParams: [v] });
          });
        }
      }
    });
  }

  onChange(e) {
    const t = e.target, act = t.dataset.act, k = t.dataset.k;
    if (!act) return;
    const n = Number(t.value);
    this.run(() => {
      switch (act) {
        case "stat-set": return this.setStat(+k, n);
        case "drv-set": return setValue("Staff_DriverData", k, "StaffID = ?", [this.id], clamp(Math.round(n), 0, 100), `${this.name} ${k} → ${n}`);
        case "max-set": return setValue("Staff_PerformanceStats", "Max", "StaffID = ? AND StatID = ?", [this.id, +k], clamp(Math.round(n), 0, 100), `${this.name} potentiel stat ${k} → ${n}`);
        case "xp": return setValue("Staff_State", "UnspentXP", "StaffID = ?", [this.id], Math.max(0, Math.round(n)), `${this.name} XP → ${n}`);
        case "num": return this.setNumber(Math.round(n));
        case "code": {
          const c = t.value.trim().toUpperCase();
          if (!/^[A-Z]{3}$/.test(c)) throw new Error("Le code pilote doit faire 3 lettres");
          return setValue("Staff_DriverData", "DriverCode", "StaffID = ?", [this.id], `[STRING_LITERAL:Value=|${c}|]`, `${this.name} code → ${c}`);
        }
        case "wants1": return setValue("Staff_DriverData", "WantsChampionDriverNumber", "StaffID = ?", [this.id], t.checked ? 1 : 0, `${this.name} #1 si champion → ${t.checked ? "oui" : "non"}`);
        case "retired": return setValue("Staff_GameData", "Retired", "StaffID = ?", [this.id], t.checked ? 1 : 0, `${this.name} retraité → ${t.checked ? "oui" : "non"}`);
        case "sl": return batch(`${this.name} super licence → ${t.checked ? "oui" : "non"}`, () => {
          setValue("Staff_DriverData", "HasSuperLicense", "StaffID = ?", [this.id], t.checked ? 1 : 0);
          setValue("Staff_DriverData", "HasRacedEnoughToJoinF1", "StaffID = ?", [this.id], t.checked ? 1 : 0);
        });
      }
    });
  }
}

/* ---------- page Équipe & finances ---------- */
/* ---------- argent et budget cap ---------- */
// Fenêtre de la saison en cours (même calcul que f1dbeditor : premier et dernier deadline de la saison)
function seasonWindow() {
  const season = currentSeason();
  const r = q("SELECT MIN(Day), MAX(Day) FROM Seasons_Deadlines WHERE SeasonID = ?", [season]).rows[0] || [];
  return { season, from: r[0] ?? -1e9, to: r[1] ?? 1e9 };
}
const CAP_WHERE = "TeamID = ? AND AffectsCostCap = 1 AND Day >= ? AND Day < ?";

function costCapInfo(team) {
  const w = seasonWindow();
  const spent = -(q1(`SELECT COALESCE(SUM(Value), 0) FROM Finance_Transactions WHERE ${CAP_WHERE}`, [team, w.from, w.to]) || 0);
  const cap = q1("SELECT CurrentValue FROM Regulations_Enum_Changes WHERE Name = 'SpendingCap'");
  return { ...w, spent, cap };
}

// Amène les dépenses comptées dans le budget cap à `target` :
// - pour baisser : réduit les dépenses les plus récentes de la saison (comme f1dbeditor)
// - pour monter : ajoute une transaction de fabrication de pièce comptée dans le cap
function setCostCapSpent(team, target) {
  const info = costCapInfo(team);
  let delta = Math.round(info.spent - target);
  if (!delta) return;
  batch(`${L("teams", team)} budget cap dépensé : ${moneyShort(info.spent)} → ${moneyShort(target)}`, () => {
    if (delta > 0) {
      const rows = q(`SELECT rowid, Value FROM Finance_Transactions WHERE ${CAP_WHERE} AND Value < 0 ORDER BY Day DESC, rowid DESC`,
        [team, info.from, info.to]).rows;
      for (const [rid, v] of rows) {
        if (delta <= 0) break;
        const add = Math.min(delta, -v);
        setValue("Finance_Transactions", "Value", "rowid = ?", [rid], v + add);
        delta -= add;
      }
      if (delta > 0) toast(`Impossible de descendre plus bas : il ne reste plus de dépenses à réduire cette saison.`, true);
    } else {
      insertRow("Finance_Transactions", ["TeamID", "Day", "Value", "TransactionType", "Reference", "AffectsCostCap"],
        [team, q1("SELECT Day FROM Player_State"), delta, 9, -1, 1]);
    }
  });
}

function renderFinanceCard(root) {
  const c = card(root, "Argent et budget cap",
    "Le <b>solde</b> est l'argent en banque. Le <b>dépensé</b> est la somme des transactions de la saison comptées dans le budget cap (<code>Finance_Transactions</code>, AffectsCostCap = 1). " +
    "Modifier le dépensé ne touche pas au solde. Le plafond se règle dans « Règlement & calendrier » (SpendingCap). Les montants acceptent <code>120M</code> ou <code>500k</code>.");
  const body = c.querySelector(".body");
  body.innerHTML = `<div class="fin-summary"></div><h3 style="margin:16px 0 8px">Transactions de la saison comptées dans le cap</h3><div class="fin-tx"></div>`;
  let team = S.playerTeam;

  const view = {
    el: $(".fin-summary", body),
    render() {
      const bal = q1("SELECT Balance FROM Finance_TeamBalance WHERE TeamID = ?", [team]);
      const i = costCapInfo(team);
      const pct = i.cap ? (100 * i.spent) / i.cap : 0;
      this.el.innerHTML = `
        <div class="fin-grid">
          <div class="fin-box"><span class="muted">Solde en banque</span><b>${bal == null ? "—" : moneyShort(bal)}</b>
            <span class="row"><input class="fin-in" data-f="bal" value="${bal ?? ""}"><button class="small" data-f="bal-go">Définir</button></span></div>
          <div class="fin-box wide"><span class="muted">Budget cap ${i.season ?? ""}</span>
            <b>${moneyShort(i.spent)} <span class="muted">/ ${i.cap ? moneyShort(i.cap) : "?"}</span></b>
            <div class="capbar ${pct > 100 ? "over" : ""}"><i style="width:${clamp(pct, 0, 100)}%"></i></div>
            <span class="${pct > 100 ? "neg" : "muted"}">${pct.toFixed(1)} % utilisé · reste ${i.cap ? moneyShort(i.cap - i.spent) : "?"}</span>
            <span class="row">Dépensé <input class="fin-in" data-f="cap" value="${Math.round(i.spent)}"><button class="small" data-f="cap-go">Appliquer</button>
              <button class="small" data-f="cap-d" data-v="-10000000">−10 M$</button><button class="small" data-f="cap-d" data-v="-50000000">−50 M$</button>
              <button class="small" data-f="cap-0">Remettre à 0</button></span></div>
        </div>`;
    },
  };
  S.grids.push(view);

  body.addEventListener("click", e => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    const val = k => $(`input[data-f="${k}"]`, body).value;
    try {
      switch (b.dataset.f) {
        case "bal-go": {
          const v = parseInput(val("bal"), 0);
          if (typeof v !== "number") throw new Error("Montant invalide");
          setValue("Finance_TeamBalance", "Balance", "TeamID = ?", [team], Math.round(v), `${L("teams", team)} solde → ${moneyShort(v)}`);
          break;
        }
        case "cap-go": {
          const v = parseInput(val("cap"), 0);
          if (typeof v !== "number") throw new Error("Montant invalide");
          setCostCapSpent(team, v);
          break;
        }
        case "cap-d": setCostCapSpent(team, Math.max(0, costCapInfo(team).spent + Number(b.dataset.v))); break;
        case "cap-0": setCostCapSpent(team, 0); break;
      }
    } catch (err) {
      toast(err.message, true);
    }
    refreshAll();
  });

  teamPicker(c, t => {
    team = t;
    view.render();
    const w = seasonWindow();
    new Grid($(".fin-tx", body), {
      table: "Finance_Transactions", where: CAP_WHERE, params: [t, w.from, w.to], order: "Day DESC, rowid DESC", pageSize: 50,
      rowLabel: r => `${L("teams", t)} ${L("transactionTypes", r.TransactionType)} du ${excelDateStr(r.Day)}`,
    });
  });
}

function renderTeam() {
  const root = $("#tab-team");
  root.innerHTML = "";
  renderFinanceCard(root);
  const g = grid2(root);

  gridCard(g, "Argent des équipes", "<code>Finance_TeamBalance</code> — solde en banque de chaque équipe.", {
    table: "Finance_TeamBalance", order: "TeamID",
    rowLabel: r => L("teams", r.TeamID),
  });
  gridCard(g, "Confiance du board", "<code>Board_Confidence</code> — confiance par saison (0–100).", {
    table: "Board_Confidence", order: "Season", rowLabel: r => `saison ${r.Season}`,
  });

  const pit = card(g, "Pit crew", "<code>Staff_PitCrew_PerformanceStats</code> — stats de l'équipe de mécaniciens (Val = actuel, MonthStartVal = début de mois).");
  teamPicker(pit, team => new Grid(pit.querySelector(".body"), {
    table: "Staff_PitCrew_PerformanceStats", where: "TeamID = ?", params: [team], order: "StatID",
    rowLabel: r => `pit crew ${L("teams", team)} ${L("staffStats", r.StatID)}`,
  }));

  gridCard(g, "Primes et droits d'engagement", "<code>Seasons</code> — PrizePool = cagnotte distribuée en fin de saison, EntryBaseFee / EntryPerPoint = frais d'inscription FIA.", {
    table: "Seasons", order: "SeasonID", rowLabel: r => `saison ${r.SeasonID}`,
  });
  gridCard(g, "Ingénieurs et scouts", "<code>SubTeam_Enum_Types</code> — coût d'embauche, coût mensuel et bonus par membre.", {
    table: "SubTeam_Enum_Types", rowLabel: r => r.Name,
  });
  gridCard(g, "Scouting", "<code>Scouting_Enum_ScoutType</code> — coût, durée et précision d'un scouting.", {
    table: "Scouting_Enum_ScoutType", rowLabel: r => r.Name,
  });
  gridCard(root, "Types de staff (règles de génération)", "<code>Staff_Enum_StaffType</code> — âges de départ / retraite, salaire de base et salaire idéal max par rôle.", {
    table: "Staff_Enum_StaffType", rowLabel: r => r.Name,
  });
}

/* ---------- page Installations ---------- */
function renderBuildings() {
  const root = $("#tab-buildings");
  root.innerHTML = "";

  const hq = card(root, "Installations d'une équipe",
    "<code>Buildings_HQ</code> — <b>DegradationValue</b> = état (1 = 100 %). Le niveau se change via <b>BuildingID</b> (voir le tableau des coûts dessous : ex. 12 → 15 = Weather Centre niveau 2 → 5). Ne touche pas aux bâtiments en construction / amélioration.");
  let team = S.playerTeam;
  const where = "TeamID = ?";
  headerButton(hq, "Tout remettre à neuf", () => {
    const n = mutate({ label: `Buildings_HQ.DegradationValue = 1 (équipe ${team})`, table: "Buildings_HQ", col: "DegradationValue", where, params: [team], setExpr: "1" });
    toast(`${n} bâtiments remis à neuf`);
    refreshAll();
  });
  headerButton(hq, "Tout au niveau max", () => {
    if (!confirm("Passer tous les bâtiments ouverts de cette équipe au niveau max ?")) return;
    const n = mutate({
      label: `Buildings_HQ niveau max (équipe ${team})`, table: "Buildings_HQ", col: "BuildingID",
      where: `${where} AND BuildingState = 2`, params: [team],
      setExpr: "(SELECT MAX(b.BuildingID) FROM Buildings b WHERE b.Type = Buildings_HQ.BuildingType)",
    });
    toast(`${n} bâtiments au niveau max`);
    refreshAll();
  });
  teamPicker(hq, t => {
    team = t;
    new Grid(hq.querySelector(".body"), {
      table: "Buildings_HQ", where, params: [t], order: "BuildingType",
      extras: [{ label: "Niveau", sql: "(SELECT UpgradeLevel FROM Buildings b WHERE b.BuildingID = Buildings_HQ.BuildingID)" }],
      cols: ["BuildingType", "BuildingID", "DegradationValue", "BuildingState", "WorkDone"],
      rowLabel: r => `${L("teams", t)} ${L("buildingTypes", r.BuildingType)}`,
    });
  });

  gridCard(root, "Coûts et durée des bâtiments (tous niveaux)",
    "<code>Buildings</code> — ConstructionCost / ConstructionWork = prix et durée d'une amélioration, UpkeepCost = entretien, RefurbishCost = rénovation, DegradationSpeed = usure.", {
      table: "Buildings", order: "BuildingID",
      cols: ["BuildingID", "Type", "Name", "UpgradeLevel", "ConstructionCost", "ConstructionWork", "UpkeepCost", "RefurbishCost", "RefurbishWork", "DegradationSpeed", "UpkeepAffectsCostCap"],
      rowLabel: r => cleanLoc(r.Name),
    });

  gridCard(root, "Effets des bâtiments",
    "<code>Buildings_Effects</code> — ce que rapporte chaque niveau (capacité d'ingénieurs, vitesse de dev, XP hebdo, expertise par bloc de soufflerie…).", {
      table: "Buildings_Effects", order: "BuildingID, EffectID",
      rowLabel: r => `${L("buildings", r.BuildingID)} ${L("buildingEffects", r.EffectID)}`,
    });
}

/* ---------- soufflerie / CFD ---------- */
const ACTIVE_PACKAGE_SQL = "(SELECT CurrentValue FROM Regulations_Enum_Changes WHERE Name = 'PartDevResourceLimit')";

// Position constructeurs de chaque équipe F1 pour la saison en cours
function standingTeamSql(posRef) {
  return `(SELECT group_concat(${teamNameSql("ts.TeamID")}, ', ') FROM Races_TeamStandings ts
    WHERE ts.SeasonID = (SELECT CurrentSeason FROM Player_State) AND ts.RaceFormula = 1 AND ts.Position = ${posRef})`;
}

function renderResources(parent) {
  const c = card(parent, "Soufflerie et CFD par position",
    "<code>Regulations_NonTechnical_PartResources</code> — blocs de soufflerie / CFD selon la position au championnat constructeurs. " +
    "Le jeu utilise le paquet = CurrentValue de <b>PartDevResourceLimit</b> (dans « Règlement en vigueur ») et ta ligne = ta position actuelle.");
  c.querySelector(".body").innerHTML = `<p class="summary"></p><div></div>`;
  c.querySelector(".row").insertAdjacentHTML("beforeend", `<label><input type="checkbox" class="allPk"> tous les paquets</label>`);
  const summary = { el: $(".summary", c), render() { this.el.innerHTML = resourceSummary(); } };
  S.grids.push(summary);
  summary.render();

  const allPk = $(".allPk", c);
  const show = () => new Grid(c.querySelector(".body > div"), {
    table: "Regulations_NonTechnical_PartResources", order: "ResourcePackage, StandingPos",
    where: allPk.checked ? undefined : `ResourcePackage = ${ACTIVE_PACKAGE_SQL}`,
    extras: [{ label: "Équipe à cette position", sql: standingTeamSql("Regulations_NonTechnical_PartResources.StandingPos"), fmt: v => String(v ?? "").split(", ").map(cleanTeam).join(", ") }],
    rowLabel: r => `paquet ${r.ResourcePackage} P${r.StandingPos}`,
  });
  allPk.addEventListener("change", show);
  show();
}

function resourceSummary() {
  try {
    const pk = q1(`SELECT ${ACTIVE_PACKAGE_SQL}`);
    const pos = q1(`SELECT Position FROM Races_TeamStandings WHERE TeamID = ? AND RaceFormula = 1
      AND SeasonID = (SELECT CurrentSeason FROM Player_State)`, [S.playerTeam]);
    const row = q("SELECT WindTunnelBlocks, CfdBlocks FROM Regulations_NonTechnical_PartResources WHERE ResourcePackage = ? AND StandingPos = ?", [pk, pos]).rows[0];
    if (pk == null || pos == null || !row) return '<span class="muted">Position de ton équipe introuvable.</span>';
    return `Ton équipe : <b>paquet ${pk}</b>, <b>P${pos}</b> → <b>${row[0]}</b> blocs soufflerie / <b>${row[1]}</b> blocs CFD. ` +
      `<span class="muted">Change la ligne P${pos} (paquet ${pk}) pour modifier ton allocation.</span>`;
  } catch (e) {
    return `<span class="muted">${esc(e.message)}</span>`;
  }
}

/* ---------- page Règlement & calendrier ---------- */
function renderRules() {
  const root = $("#tab-rules");
  root.innerHTML = "";
  const g = grid2(root);

  gridCard(g, "Règlement en vigueur",
    "<code>Regulations_Enum_Changes</code> — <b>CurrentValue</b> : SpendingCap = budget cap, EngineLimit / ErsLimit / GearboxLimit = pièces par saison, PartDevResourceLimit = paquet de soufflerie/CFD, PointScheme = barème, 0/1 pour les bonus.", {
      table: "Regulations_Enum_Changes", cols: ["ChangeID", "Name", "CurrentValue", "PreviousValue", "MinValue", "MaxValue"],
      rowLabel: r => r.Name,
    });
  renderResources(g);
  gridCard(g, "Barèmes de points", "<code>Regulations_NonTechnical_PointSchemes</code> — barème utilisé = CurrentValue de PointScheme.", {
    table: "Regulations_NonTechnical_PointSchemes", order: "PointScheme, RacePos",
    rowLabel: r => `barème ${r.PointScheme} P${r.RacePos}`,
  });
  gridCard(g, "Répartition des primes", "<code>Regulations_NonTechnical_PrizeShare</code> — part de la cagnotte par position (système = CurrentValue de PrizeShare).", {
    table: "Regulations_NonTechnical_PrizeShare", order: "DistributionSystem, FinishPosition",
    rowLabel: r => `système ${r.DistributionSystem} P${r.FinishPosition}`,
  });

  const season = currentSeason();
  gridCard(root, `Calendrier et météo ${season ?? ""}`,
    "<code>Races</code> — météo prévue par session (Rain…, Temperature… en °C, WeatherState…) et format du week-end (WeekendType). Ne modifie que les courses à venir (statut Pending).", {
      table: "Races", where: season != null ? "SeasonID = ?" : undefined, params: season != null ? [season] : [], order: "Day",
      rowLabel: r => `course ${r.RaceID} ${L("tracks", r.TrackID)}`,
    });
  gridCard(root, "Circuits", "<code>Races_Tracks</code> — tours, probabilité de safety car, temps perdu dans la pitlane…", {
    table: "Races_Tracks", order: "TrackID",
    cols: ["TrackID", "Name", "Laps", "SprintLaps", "TrackLength", "SafetyCarChance", "PitLaneTimeLoss", "GreenFlagTimeLoss", "SafetyCarTimeLoss"],
    rowLabel: r => cleanLoc(r.Name),
  });
}

/* ---------- page Performances ---------- */
const CAR_PARTS = [0, 3, 4, 5, 6, 7, 8];
const PART_FR = { 0: "Moteur", 3: "Châssis", 4: "Aileron avant", 5: "Aileron arrière", 6: "Pontons", 7: "Fond plat", 8: "Suspension" };
const PSTAT_FR = {
  0: "Airflow avant", 1: "Sensibilité airflow", 2: "Refroid. freins", 3: "Delta DRS", 4: "Réduction traînée", 5: "Refroid. moteur",
  6: "Conso. carburant", 7: "Appui basse vitesse", 8: "Appui moy. vitesse", 9: "Appui haute vitesse", 10: "Puissance",
  11: "Perte de perf.", 12: "Seuil de perf.", 13: "Airflow milieu", 14: "Plage de fonctionnement", 15: "Poids",
};
const pstatName = (pt, st) => (st === 15 && pt <= 2 ? "Durée de vie" : PSTAT_FR[st] || L("partStats", st));
const PSTAT_STEP = { 7: 0.01, 8: 0.01, 9: 0.005, 15: 10 };

// Poids de chaque pièce dans chaque stat de la voiture, et contributions des stats aux attributs
// (mêmes constantes que f1dbeditor, carConstants.js)
const STAT_FACTORS = {
  0: { 4: 0.4, 6: 0.2, 8: 0.4 }, 1: { 4: 0.4, 5: 0.4, 7: 0.2 }, 2: { 4: 0.4, 8: 0.6 }, 3: { 5: 0.75, 3: 0.25 },
  4: { 3: 0.2, 5: 0.3, 6: 0.2, 7: 0.2, 8: 0.1 }, 5: { 3: 0.4, 6: 0.6 }, 6: { 0: 1 },
  7: { 4: 0.2, 5: 0.2, 7: 0.3, 8: 0.3 }, 8: { 4: 0.2, 5: 0.2, 7: 0.5, 8: 0.1 }, 9: { 4: 0.2, 5: 0.2, 7: 0.5, 8: 0.1 },
  10: { 0: 1 }, 11: { 0: 1 }, 12: { 0: 1 }, 13: { 3: 0.6, 6: 0.4 }, 14: { 0: 1 },
  15: { 1: 0, 2: 0, 3: 5, 4: 2, 5: 3, 6: 5, 7: 4, 8: 1 },
};
// [clé, libellé, contributions {stat: poids}, [min, max] physique, unité, poids dans l'overall]
const CAR_ATTRS = [
  ["top_speed", "Vitesse de pointe", { 4: 1 }, [313, 328], "km/h", 0.15],
  ["acceleration", "Accélération", { 10: 0.5, 4: 0.5, 16: 0.15 }, [1.8, 1.9], "G", 0.05],
  ["drs", "DRS", { 3: 1 }, [0, 100], "%", 0.1],
  ["low_speed", "Virages lents", { 0: 0.6, 7: 1, 16: 0.24 }, [2, 3], "G", 0.18],
  ["medium_speed", "Virages moyens", { 0: 0.4, 13: 0.4, 8: 1, 16: 0.27 }, [3, 4], "G", 0.18],
  ["high_speed", "Virages rapides", { 13: 0.6, 9: 1, 16: 0.24 }, [4, 5.5], "G", 0.18],
  ["dirty_air", "Air sale", { 1: 1 }, [0, 100], "%", 0.05],
  ["brake_cooling", "Refroid. freins", { 2: 1 }, [0, 100], "%", 0.05],
  ["engine_cooling", "Refroid. moteur", { 5: 1 }, [0, 100], "%", 0.015],
];
const PERF_MODES = { 1: "Voiture 1", 2: "Voiture 2", best: "Meilleures pièces de la saison" };

// Conversion UnitValue (affichée en jeu) ↔ Value (interne), déduite de la save par régression linéaire
function perfConv() {
  if (S.perfConv) return S.perfConv;
  const acc = {};
  for (const [pt, st, uv, v] of q(`SELECT d.PartType, s.PartStat, s.UnitValue, s.Value
      FROM Parts_Designs_StatValues s JOIN Parts_Designs d ON d.DesignID = s.DesignID`).rows) {
    const k = convKey(pt, st);
    const a = (acc[k] = acc[k] || { n: 0, x: 0, y: 0, xx: 0, xy: 0 });
    a.n++; a.x += uv; a.y += v; a.xx += uv * uv; a.xy += uv * v;
  }
  S.perfConv = {};
  for (const [k, a] of Object.entries(acc)) {
    const varx = a.xx - (a.x * a.x) / a.n;
    if (a.n < 2 || Math.abs(varx) < 1e-9) continue;
    const slope = (a.xy - (a.x * a.y) / a.n) / varx;
    S.perfConv[k] = { a: slope, b: (a.y - slope * a.x) / a.n };
  }
  return S.perfConv;
}
const convKey = (pt, st) => (st === 15 ? `p${pt}|15` : `${pt <= 2 ? "pu" : "ch"}|${st}`);
const toValue = (pt, st, uv) => { const c = perfConv()[convKey(pt, st)] || { a: 10, b: 0 }; return c.a * uv + c.b; };
const toUnit = (pt, st, v) => { const c = perfConv()[convKey(pt, st)] || { a: 10, b: 0 }; return (v - c.b) / c.a; };
// Conversions relatives à la valeur existante : garde exactement l'écart du jeu entre UnitValue et Value
const slopeOf = (pt, st) => (perfConv()[convKey(pt, st)] || { a: 10 }).a;
const valueFromUnit = (pt, st, old, uv) => old.v + slopeOf(pt, st) * (uv - old.uv);
const unitFromValue = (pt, st, old, v) => old.uv + (v - old.v) / slopeOf(pt, st);

const perfTeams = () => q("SELECT DISTINCT TeamID FROM Parts_CarLoadout ORDER BY TeamID").rows.map(r => r[0]);

// {PartType: DesignID} pour une équipe : voiture 1, voiture 2 ou meilleures pièces terminées de la saison
function teamDesigns(team, mode) {
  const out = {};
  const loadout = mode === "best" ? 1 : +mode;
  for (const [pt, did] of q("SELECT PartType, DesignID FROM Parts_CarLoadout WHERE TeamID = ? AND LoadoutID = ?", [team, loadout]).rows)
    if (CAR_PARTS.includes(pt)) out[pt] = did;
  if (mode === "best") {
    const season = currentSeason();
    for (const pt of CAR_PARTS.slice(1)) {
      const best = q1(`SELECT MAX(DesignID) FROM Parts_Designs WHERE PartType = ? AND TeamID = ? AND ValidFrom = ?
        AND (DayCompleted > 0 OR DayCreated < 0)`, [pt, team, season]);
      if (best != null) out[pt] = best;
    }
  }
  return out;
}

function designStats(ids) {
  const m = {};
  const list = [...new Set(ids.filter(x => x != null))];
  if (!list.length) return m;
  for (const [did, st, v, uv] of q(`SELECT DesignID, PartStat, Value, UnitValue FROM Parts_Designs_StatValues WHERE DesignID IN (${list.join(",")})`).rows)
    (m[did] = m[did] || {})[st] = { v, uv };
  return m;
}

function carPerformance(designs, stats) {
  const ps = {};
  for (const [pt, did] of Object.entries(designs))
    for (const [st, { v }] of Object.entries(stats[did] || {})) {
      const f = (STAT_FACTORS[st] || {})[pt] || 0;
      ps[st] = (ps[st] || 0) + v * f;
    }
  ps[16] = (20000 - (ps[15] || 0)) / 20;
  const attrs = {};
  let ovr = 0;
  for (const [key, , contrib, , , w] of CAR_ATTRS) {
    const tot = Object.values(contrib).reduce((a, b) => a + b, 0);
    let s = 0;
    for (const [st, c] of Object.entries(contrib)) s += ((c / tot) * (ps[st] || 0)) / 10;
    attrs[key] = s;
    ovr += s * w;
  }
  return { attrs, ovr };
}

function attrPhysical(key, pct) {
  const a = CAR_ATTRS.find(x => x[0] === key);
  const v = a[3][0] + ((a[3][1] - a[3][0]) * pct) / 100;
  return { v, txt: `${v.toLocaleString("fr-FR", { maximumFractionDigits: a[4] === "G" ? 3 : 1, minimumFractionDigits: a[4] === "G" ? 3 : 1 })} ${a[4]}` };
}

// Performances de toutes les équipes pour un mode donné
function gridPerformance(mode) {
  const teams = perfTeams();
  const designs = Object.fromEntries(teams.map(t => [t, teamDesigns(t, mode)]));
  const stats = designStats(teams.flatMap(t => Object.values(designs[t])));
  return teams.map(t => ({ team: t, designs: designs[t], ...carPerformance(designs[t], stats), stats }));
}

function heat(frac) {
  // 0 = rouge, 1 = vert
  const h = Math.round(clamp(frac, 0, 1) * 120);
  return `hsla(${h}, 70%, 45%, .28)`;
}

function renderPerf() {
  const root = $("#tab-perf");
  root.innerHTML = "";
  const st = { mode: "1", team: S.playerTeam ?? perfTeams()[0] };

  const rank = card(root, "Classement des voitures",
    "Overall calculé comme dans f1dbeditor, à partir des stats des pièces. Les attributs sont convertis en unités du jeu. Clique sur une équipe pour éditer sa voiture.");
  rank.querySelector(".row").insertAdjacentHTML("beforeend",
    `<select class="perfMode">${Object.entries(PERF_MODES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>`);
  const ranking = { el: rank.querySelector(".body"), render() { renderRanking(this.el, st, editor); } };

  const edCard = card(root, "Éditer une voiture", "");
  const editor = { el: edCard.querySelector(".body"), render() { renderCarEditor(this.el, st, ranking); } };
  S.grids.push(ranking, editor);

  $(".perfMode", rank).addEventListener("change", e => { st.mode = e.target.value; ranking.render(); editor.render(); });
  ranking.render();
  editor.render();
}

function renderRanking(el, st, editor) {
  const res = gridPerformance(st.mode).sort((a, b) => b.ovr - a.ovr);
  if (!res.length) { el.innerHTML = '<p class="muted">Aucune voiture trouvée.</p>'; return; }
  const best = res[0].ovr, worst = res[res.length - 1].ovr;
  const ranges = Object.fromEntries(CAR_ATTRS.map(([k]) => {
    const vals = res.map(r => r.attrs[k]);
    return [k, [Math.min(...vals), Math.max(...vals)]];
  }));
  el.innerHTML = `<div class="gridwrap"><table class="grid perfgrid"><thead><tr>
      <th>#</th><th>Équipe</th><th>Overall</th><th>Écart</th>
      ${CAR_ATTRS.map(a => `<th title="${esc(a[1])}">${esc(a[1])}</th>`).join("")}
    </tr></thead><tbody>${res.map((r, i) => `
      <tr class="clickable ${r.team === st.team ? "selected" : ""} ${r.team === S.playerTeam ? "mine" : ""}" data-team="${r.team}">
        <td>${i + 1}</td>
        <td class="tname">${esc(L("teams", r.team))}</td>
        <td><div class="ovr"><b>${r.ovr.toFixed(2)}</b><span class="obar"><i style="width:${worst === best ? 100 : 30 + (70 * (r.ovr - worst)) / (best - worst)}%"></i></span></div></td>
        <td class="num muted">${i ? (r.ovr - best).toFixed(2) : "—"}</td>
        ${CAR_ATTRS.map(([k]) => {
          const [mn, mx] = ranges[k];
          return `<td class="num" style="background:${heat(mx === mn ? 0.5 : (r.attrs[k] - mn) / (mx - mn))}" title="${r.attrs[k].toFixed(2)} %">${attrPhysical(k, r.attrs[k]).txt}</td>`;
        }).join("")}
      </tr>`).join("")}</tbody></table></div>`;
  el.querySelectorAll("tr[data-team]").forEach(tr => tr.addEventListener("click", () => {
    st.team = +tr.dataset.team;
    st.override = {};
    renderRanking(el, st, editor);
    editor.render();
    editor.el.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function renderCarEditor(el, st, ranking) {
  const team = st.team;
  st.override = st.override || {};
  if (st.adjustExp === undefined) st.adjustExp = true;
  const all = gridPerformance(st.mode);
  const me = all.find(r => r.team === team);
  if (!me) { el.innerHTML = '<p class="muted">Choisis une équipe dans le classement.</p>'; return; }

  // Designs affichés : ceux du mode, ou ceux choisis à la main dans les listes
  const designs = { ...me.designs, ...st.override };
  const stats = designStats([...Object.values(designs), ...all.flatMap(r => Object.values(r.designs))]);
  const perf = carPerformance(designs, stats);
  const sorted = all.map(r => (r.team === team ? perf.ovr : r.ovr)).sort((a, b) => b - a);
  const pos = sorted.indexOf(perf.ovr) + 1;
  const avg = Object.fromEntries(CAR_ATTRS.map(([k]) => [k, all.reduce((a, r) => a + r.attrs[k], 0) / all.length]));

  // Classement de chaque stat de pièce par rapport aux autres équipes
  // (le poids, stat 15, est meilleur quand il est bas)
  const rankOf = (pt, s, v) => 1 + all.filter(r => {
    const o = (stats[r.designs[pt]] || {})[s]?.v;
    return r.team !== team && o != null && (s === 15 ? o < v : o > v);
  }).length;
  const used = d => [1, 2].filter(l => q1("SELECT count(*) FROM Parts_CarLoadout WHERE TeamID = ? AND LoadoutID = ? AND DesignID = ?", [team, l, d]));

  const partCard = pt => {
    const did = designs[pt];
    const opts = q(`SELECT DesignID, DesignNumber, ValidFrom, DayCompleted FROM Parts_Designs WHERE TeamID = ? AND PartType = ?
      AND (ValidFrom >= ? OR DesignID = ?) ORDER BY DesignID DESC`, [team, pt, (currentSeason() ?? 0) - 1, did ?? -1]).rows;
    const rows = Object.entries(stats[did] || {}).map(([s, x]) => [+s, x]).sort((a, b) => a[0] - b[0]);
    const cars = did != null ? used(did) : [];
    return `<div class="pcard">
      <div class="pc-head"><h3>${esc(PART_FR[pt])}</h3>
        <select data-pt="${pt}" class="pc-design">${opts.map(([id, num, vf, dc]) => {
          const tags = used(id).map(l => `V${l}`).join("+");
          return `<option value="${id}" ${id === did ? "selected" : ""}>#${num ?? "?"} · ${vf}${dc < 0 && pt !== 0 ? " · en cours" : ""}${tags ? ` · ${tags}` : ""} (ID ${id})</option>`;
        }).join("")}</select></div>
      <div class="pc-sub muted">${cars.length ? `Monté sur ${cars.map(l => `voiture ${l}`).join(" et ")}` : "Pas monté"}${cars.length === 2 ? " — modifier ce design change les deux voitures" : ""}</div>
      ${rows.length ? rows.map(([s, x]) => {
        const r = rankOf(pt, s, x.v);
        const step = PSTAT_STEP[s] || 1;
        const dec = step < 0.1 ? 3 : step < 1 ? 1 : 2;
        return `<div class="pstat">
          <span class="pl">${esc(pstatName(pt, s))}</span>
          <span class="pv"><button class="pm" data-ed="${did}|${pt}|${s}" data-d="${-step}">−</button><input type="number" step="${step}" data-ed="${did}|${pt}|${s}" value="${+x.uv.toFixed(dec)}"><button class="pm" data-ed="${did}|${pt}|${s}" data-d="${step}">+</button></span>
          <span class="prank ${r === 1 ? "top" : r >= all.length - 1 ? "low" : ""}" title="Rang parmi ${all.length} équipes (valeur interne ${x.v.toFixed(1)})">${r}/${all.length}</span>
        </div>`;
      }).join("") : '<p class="muted">Aucune stat.</p>'}
    </div>`;
  };

  el.innerHTML = `
    <div class="ce-tools row">
      <label>Équipe <select class="ce-team">${perfTeams().map(t => `<option value="${t}" ${t === team ? "selected" : ""}>${esc(L("teams", t))}${t === S.playerTeam ? " (toi)" : ""}</option>`).join("")}</select></label>
      <label><input type="checkbox" class="ce-exp" ${st.adjustExp ? "checked" : ""}> ajuster aussi l'expertise de l'équipe</label>
      <span class="sep"></span>
      <label>Boost <input type="number" class="ce-boost" value="5" step="1" style="width:60px"> %</label><button class="small ce-boostgo">Appliquer à toutes les pièces affichées</button>
      <span class="sep"></span>
      <label>Copier les stats de <select class="ce-src">${perfTeams().filter(t => t !== team).map(t => `<option value="${t}">${esc(L("teams", t))}</option>`).join("")}</select></label><button class="small ce-copy">Copier</button>
    </div>
    <div class="ce-summary">
      <div class="ce-ovr"><span class="muted">Overall</span><b>${perf.ovr.toFixed(2)}</b><span class="muted">${pos}e / ${all.length}</span></div>
      ${CAR_ATTRS.map(([k, label]) => {
        const d = perf.attrs[k] - avg[k];
        return `<div class="ce-attr"><span class="muted">${esc(label)}</span><b>${attrPhysical(k, perf.attrs[k]).txt}</b>
          <span class="${d >= 0 ? "pos" : "neg"}">${d >= 0 ? "+" : ""}${d.toFixed(1)} pts vs moy.</span></div>`;
      }).join("")}
    </div>
    <p class="hint">Valeurs en unités du jeu (UnitValue) : modifie avec −/+ ou tape une valeur. « Rang » = position de la stat face aux autres équipes (${esc(PERF_MODES[st.mode])}).
      Si « ajuster l'expertise » est coché, l'expertise de l'équipe suit dans la même proportion (les prochains designs partiront de ce niveau).</p>
    <div class="pgrid">${CAR_PARTS.filter(pt => designs[pt] != null).map(partCard).join("")}</div>`;

  const name = L("teams", team);
  const rerender = () => refreshAll();

  $(".ce-team", el).addEventListener("change", e => { st.team = +e.target.value; st.override = {}; ranking.render(); rerender(); });
  $(".ce-exp", el).addEventListener("change", e => { st.adjustExp = e.target.checked; });
  el.querySelectorAll(".pc-design").forEach(s => s.addEventListener("change", () => { st.override[+s.dataset.pt] = +s.value; rerender(); }));

  const apply = (did, pt, s, uv) => {
    const old = stats[did][s];
    const v = valueFromUnit(pt, s, old, uv);
    batch(`${name} ${PART_FR[pt]} (design ${did}) ${pstatName(pt, s)} : ${+old.uv.toFixed(3)} → ${+uv.toFixed(3)}`, () => setPartStat(team, did, pt, s, uv, v, old.v, st.adjustExp));
  };
  el.querySelectorAll("button[data-ed]").forEach(b => b.addEventListener("click", () => {
    const [did, pt, s] = b.dataset.ed.split("|").map(Number);
    apply(did, pt, s, stats[did][s].uv + Number(b.dataset.d));
    rerender();
  }));
  el.querySelectorAll("input[data-ed]").forEach(i => i.addEventListener("change", () => {
    const [did, pt, s] = i.dataset.ed.split("|").map(Number);
    const uv = Number(i.value.replace(",", "."));
    if (!isFinite(uv)) return toast("Valeur invalide", true);
    apply(did, pt, s, uv);
    rerender();
  }));

  $(".ce-boostgo", el).addEventListener("click", () => {
    const p = Number($(".ce-boost", el).value);
    if (!isFinite(p) || !p) return;
    const f = 1 + p / 100;
    batch(`${name} boost ${p > 0 ? "+" : ""}${p} % (${PERF_MODES[st.mode]})`, () => {
      for (const [pt, did] of Object.entries(designs))
        for (const [s, x] of Object.entries(stats[did] || {})) {
          if (+s === 15) continue;
          const v = x.v * f;
          setPartStat(team, did, +pt, +s, unitFromValue(+pt, +s, x, v), v, x.v, st.adjustExp);
        }
    });
    toast(`Boost ${p} % appliqué`);
    rerender();
  });

  $(".ce-copy", el).addEventListener("click", () => {
    const src = +$(".ce-src", el).value;
    const srcDesigns = all.find(r => r.team === src)?.designs || {};
    if (!confirm(`Copier les stats des pièces de ${L("teams", src)} sur ${name} (${PERF_MODES[st.mode]}) ?`)) return;
    const srcStats = designStats(Object.values(srcDesigns));
    batch(`${name} : stats copiées depuis ${L("teams", src)}`, () => {
      for (const [pt, did] of Object.entries(designs)) {
        const from = srcStats[srcDesigns[pt]];
        if (!from) continue;
        for (const [s, x] of Object.entries(stats[did] || {})) {
          if (!from[s] || +s === 15) continue;
          setPartStat(team, did, +pt, +s, from[s].uv, from[s].v, x.v, st.adjustExp);
        }
      }
    });
    toast(`Stats de ${L("teams", src)} copiées`);
    rerender();
  });
}

// Écrit une stat de design (UnitValue + Value) et, si demandé, ajuste l'expertise dans la même proportion
function setPartStat(team, did, pt, s, uv, v, oldV, adjustExp) {
  setValue("Parts_Designs_StatValues", "UnitValue", "DesignID = ? AND PartStat = ?", [did, s], uv);
  setValue("Parts_Designs_StatValues", "Value", "DesignID = ? AND PartStat = ?", [did, s], v);
  if (adjustExp && s !== 15 && oldV > 0)
    mutate({
      table: "Parts_TeamExpertise", col: "Expertise", where: "TeamID = ? AND PartType = ? AND PartStat = ?",
      params: [team, pt, s], setExpr: "Expertise * ?", setParams: [v / oldV],
    });
}

/* ---------- onglet Tables ---------- */
function renderTableList() {
  const f = $("#tableFilter").value.trim().toLowerCase();
  const items = [];
  for (const [name, t] of tables()) {
    const hitName = !f || name.toLowerCase().includes(f);
    const hitCols = f ? t.cols.filter(c => c.name.toLowerCase().includes(f)).map(c => c.name) : [];
    if (!hitName && !hitCols.length) continue;
    items.push(`<li data-t="${esc(name)}" class="${S.activeTable === name ? "active" : ""}"><span>${esc(name)}${hitCols.length ? `<span class="cols">${esc(hitCols.join(", "))}</span>` : ""}</span><span class="n">${t.count}</span></li>`);
  }
  $("#tableList").innerHTML = items.join("") || '<li class="muted">Aucun résultat</li>';
}

function openTable(name) {
  S.activeTable = name;
  renderTableList();
  const v = $("#tableView");
  v.innerHTML = `
    <div class="row spread" style="margin-bottom:8px"><h2>${esc(name)}</h2>
      <span class="muted">${tables().get(name).cols.map(c => esc(c.name)).join(" · ")}</span></div>
    <form class="wherebar" id="whereForm"><input id="whereInput" placeholder="Filtre SQL (ex: TeamID = 1 AND PartType = 4)"><button class="primary">Filtrer</button><button type="button" id="whereClear">Effacer</button></form>
    <div id="tableGrid"></div>`;
  const grid = new Grid($("#tableGrid"), { table: name });
  $("#whereForm").addEventListener("submit", e => {
    e.preventDefault();
    grid.o.where = $("#whereInput").value.trim() || undefined;
    grid.page = 0;
    grid.render();
  });
  $("#whereClear").addEventListener("click", () => { $("#whereInput").value = ""; grid.o.where = undefined; grid.render(); });
}

/* ---------- onglet SQL ---------- */
const HIST_KEY = "f1m-sql-history";
function sqlHistory() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } }
function renderSqlHistory() {
  $("#sqlHistory").innerHTML = sqlHistory().map(s => `<div title="${esc(s)}">${esc(s)}</div>`).join("");
}
function runSql() {
  const sql = $("#sqlInput").value.trim();
  if (!sql || !S.db) return;
  const out = $("#sqlResult");
  try {
    const t0 = performance.now();
    const res = S.db.exec(sql);
    const changes = S.db.getRowsModified();
    const writes = /\b(insert|update|delete|replace|create|drop|alter)\b/i.test(sql);
    if (writes) {
      S.tableCache = null;
      S.fkCache = null;
      log(`SQL (${changes} lignes) : ${sql.replace(/\s+/g, " ").slice(0, 300)}`);
      setDirty(true);
      refreshAll();
      renderTableList();
    }
    out.innerHTML = `<p class="muted">${res.length ? "" : writes ? `${changes} lignes modifiées. ` : "Aucun résultat. "}${(performance.now() - t0).toFixed(0)} ms</p>` +
      res.map(r => `<div class="card"><p class="muted">${r.values.length} lignes${r.values.length > 1000 ? " (1000 affichées)" : ""}</p><div class="gridwrap"><table class="grid"><thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${r.values.slice(0, 1000).map(row => `<tr>${row.map(v => `<td class="${typeof v === "number" ? "num" : ""}">${esc(fmt(v))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`).join("");
    const h = [sql, ...sqlHistory().filter(x => x !== sql)].slice(0, 30);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch {}
    renderSqlHistory();
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

/* ---------- onglet Unpack / Repack ---------- */
function renderRepack() {
  const root = $("#tab-repack");
  const s = S.save;
  root.innerHTML = `
    <div class="grid2">
      ${s ? `<div class="card"><h2>Save chargée</h2><p></p>
        <dl class="kv">
          <dt>Fichier</dt><dd>${esc(S.fileName)}</dd>
          <dt>Jeu</dt><dd>${esc(s.game)}</dd>
          <dt>Build</dt><dd>${esc(s.buildId)}</dd>
          <dt>chunk1 (en-tête)</dt><dd>${s.header.length} o</dd>
          <dt>main.db</dt><dd>${s.dbs[0].length.toLocaleString("fr-FR")} o</dd>
          <dt>backup1.db</dt><dd>${s.dbs[1].length.toLocaleString("fr-FR")} o</dd>
          <dt>backup2.db</dt><dd>${s.dbs[2].length.toLocaleString("fr-FR")} o</dd>
        </dl></div>
      <div class="card"><h2>Unpack</h2>
        <p class="hint">Mêmes fichiers que le repacker Python (<code>chunk1</code>, <code>main.db</code>, <code>backup1.db</code>, <code>backup2.db</code>) — pour éditer dans DB Browser for SQLite si tu préfères.</p>
        <div class="row">
          <button data-dl="main">main.db (avec tes modifs)</button>
          <button data-dl="b1">backup1.db</button>
          <button data-dl="b2">backup2.db</button>
          <button data-dl="chunk1">chunk1</button>
          <button data-dl="orig">Save d'origine (.sav)</button>
        </div></div>
      <div class="card"><h2>Importer un main.db</h2>
        <p class="hint">Remplace la base de la save chargée par un <code>main.db</code> modifié ailleurs (DB Browser…). Puis « Enregistrer ».</p>
        <input type="file" id="importDb" accept=".db,.sqlite,.sqlite3"></div>` : ""}
      <div class="card"><h2>Repack depuis des fichiers</h2>
        <p class="hint">Équivalent de <code>script.py --operation repack</code> : sélectionne <code>chunk1</code> + <code>main.db</code> (+ <code>backup1.db</code>, <code>backup2.db</code>) en une fois. Fonctionne sans save chargée.</p>
        <input type="file" id="repackFiles" multiple></div>
    </div>`;

  root.querySelectorAll("[data-dl]").forEach(b => b.addEventListener("click", () => {
    const n = baseName();
    switch (b.dataset.dl) {
      case "main": return download(S.db.export(), "main.db");
      case "b1": return download(s.dbs[1], "backup1.db");
      case "b2": return download(s.dbs[2], "backup2.db");
      case "chunk1": return download(s.header, "chunk1");
      case "orig": return download(S.origBytes, `${n}.original.sav`);
    }
  }));

  const imp = $("#importDb");
  if (imp) imp.addEventListener("change", async () => {
    const f = imp.files[0];
    if (!f) return;
    const u8 = new Uint8Array(await f.arrayBuffer());
    if (new TextDecoder().decode(u8.subarray(0, 15)) !== "SQLite format 3") return toast("Ce fichier n'est pas une base SQLite", true);
    S.db.close();
    Object.assign(S, { db: new S.SQL.Database(u8), undo: [], edited: new Set(), grids: [], tableCache: null, fkCache: null, perfConv: null });
    log(`main.db remplacé par ${f.name}`);
    setDirty(true);
    renderAll();
    toast(`${f.name} importé — pense à enregistrer`);
  });

  $("#repackFiles").addEventListener("change", async e => {
    const files = {};
    for (const f of e.target.files) files[f.name.toLowerCase()] = new Uint8Array(await f.arrayBuffer());
    if (!files.chunk1 || !files["main.db"]) return toast("Il faut au minimum chunk1 et main.db", true);
    const out = F1Save.buildSave(files.chunk1, [files["main.db"], files["backup1.db"], files["backup2.db"]], d => pako.deflate(d, { level: 9 }));
    download(out, "repacked.sav");
    toast("repacked.sav généré");
    e.target.value = "";
  });
}

/* ---------- événements ---------- */
document.body.classList.add("empty");

$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  document.body.classList.toggle("on-repack", b.dataset.tab === "repack");
  if (b.dataset.tab === "repack" && !S.save) renderRepack();
});

$("#btnOpen").addEventListener("click", openFile);
$("#dropzone").addEventListener("click", openFile);
$("#fileInput").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (f) await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, null);
  e.target.value = "";
});
$("#btnSave").addEventListener("click", save);
$("#btnSaveAs").addEventListener("click", saveAs);
$("#btnUndo").addEventListener("click", undo);
$("#btnReset").addEventListener("click", () => {
  if (S.origBytes && confirm("Recharger la save telle qu'elle était à l'ouverture ? Toutes les modifications de la session seront perdues."))
    loadBytes(S.origBytes, S.fileName, S.handle);
});
$("#tableFilter").addEventListener("input", () => S.db && renderTableList());
$("#tableList").addEventListener("click", e => { const li = e.target.closest("li[data-t]"); if (li) openTable(li.dataset.t); });
$("#btnRunSql").addEventListener("click", runSql);
$("#sqlInput").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); } });
$("#sqlHistory").addEventListener("click", e => { if (e.target.title) $("#sqlInput").value = e.target.title; });
renderSqlHistory();

document.addEventListener("keydown", e => {
  if (!S.db || !(e.ctrlKey || e.metaKey)) return;
  if (e.key === "s") { e.preventDefault(); save(); }
  if (e.key === "z" && !e.target.closest("input, textarea")) { e.preventDefault(); undo(); }
});

let dragDepth = 0;
document.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", async e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (!item || (e.target.closest && e.target.closest("input[type=file]"))) return;
  // les items ne sont plus lisibles après le premier await
  const handlePromise = item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
  const file = item.getAsFile();
  if (S.dirty && !confirm("Des modifications non enregistrées seront perdues. Continuer ?")) return;
  const handle = await handlePromise;
  const f = handle && handle.kind === "file" ? await handle.getFile() : file;
  if (f) loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, handle && handle.kind === "file" ? handle : null);
});

window.addEventListener("beforeunload", e => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
