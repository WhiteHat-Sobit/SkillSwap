// База данных SQLite: схема, перенос демо-данных и все SQL-запросы
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "data");
fs.mkdirSync(dir, { recursive: true });
const FILE = process.env.DB_FILE || path.join(dir, "skillswap.db");

// Категории навыков (используются при регистрации и в фильтрах сайта)
const CATS = { dev: "Разработка", des: "Дизайн & 3D", lang: "Языки", mkt: "Маркетинг", mus: "Музыка", math: "Математика", other: "Другое" };

// Слоты свободного времени для «умного подбора»
const SLOTS = { "wd-mor": "Будни утром", "wd-day": "Будни днём", "wd-eve": "Будни вечером", "we-mor": "Выходные утром", "we-day": "Выходные днём", "we-eve": "Выходные вечером" };

const open = () => { const d = new Database(FILE); d.pragma("journal_mode = WAL"); d.pragma("foreign_keys = ON"); return d; };
let db = open();

// База прежней версии (без статусов заявок) сохраняется как копия, создаётся новая
const oldCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (oldCols.length && !oldCols.includes("status")) {
  db.close();
  const bak = FILE.replace(/\.db$/, "") + ".v2-backup.db";
  if (fs.existsSync(bak)) fs.unlinkSync(bak);
  fs.renameSync(FILE, bak);
  for (const s of ["-wal", "-shm"]) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s);
  db = open();
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  status_note TEXT,
  teach_cats TEXT NOT NULL DEFAULT '[]', teach_skills TEXT NOT NULL DEFAULT '',
  learn_cats TEXT NOT NULL DEFAULT '[]', learn_skills TEXT NOT NULL DEFAULT '',
  verify_hash TEXT, verify_expires INTEGER,
  availability TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL,
  score INTEGER NOT NULL, rating REAL NOT NULL, exchanges INTEGER NOT NULL, ew TEXT NOT NULL,
  online INTEGER NOT NULL, globe INTEGER NOT NULL,
  cats TEXT NOT NULL, wants TEXT NOT NULL DEFAULT '',
  teach TEXT NOT NULL, teach_style TEXT, learn TEXT NOT NULL, learn_style TEXT NOT NULL,
  location TEXT NOT NULL, reply TEXT, initials TEXT NOT NULL, search TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS swaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT,
  UNIQUE (user_id, member_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  swap_id INTEGER REFERENCES swaps(id) ON DELETE CASCADE,
  ref_user_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_swap ON messages (swap_id, id);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL, comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (swap_id, author_id)
);
CREATE TABLE IF NOT EXISTS workshops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL,
  starts_at TEXT NOT NULL, capacity INTEGER NOT NULL, link TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workshop_members (
  workshop_id INTEGER NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (workshop_id, user_id)
);
CREATE TABLE IF NOT EXISTS call_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`);

// Добавляем поля подтверждения email в уже существующую базу
if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "verify_hash"))
  db.exec("ALTER TABLE users ADD COLUMN verify_hash TEXT; ALTER TABLE users ADD COLUMN verify_expires INTEGER;");

if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "availability"))
  db.exec("ALTER TABLE users ADD COLUMN availability TEXT NOT NULL DEFAULT '[]'");

// Демо-участники из дизайна (один раз). Админ может удалить их в админке
const seedFile = path.join(dir, "seed.json");
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'seeded'").get() && fs.existsSync(seedFile)) {
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  const ins = db.prepare(`INSERT INTO members (id,user_id,name,role,score,rating,exchanges,ew,online,globe,cats,wants,teach,teach_style,learn,learn_style,location,reply,initials,search)
    VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const meta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)");
  db.transaction(() => {
    for (const m of seed.members)
      ins.run(m.id, m.n, m.r, m.m, m.s, m.e, m.ew, m.on ? 1 : 0, m.w ? 1 : 0, `,${m.c},`, "",
        JSON.stringify(m.t), m.ts ? JSON.stringify(m.ts) : null, JSON.stringify(m.l), JSON.stringify(m.ls),
        m.loc, m.a, m.i, [m.n, m.r, ...m.t, ...m.l].join(" ").toLowerCase());
    for (const [k, v] of Object.entries(seed.stats)) meta.run(k, v);
    meta.run("seeded", 1);
  })();
}

const J = (s) => JSON.parse(s || "[]");
const labels = (cats) => J(cats).map((c) => CATS[c]).filter(Boolean);
const prof = (cats, skills) => ({ cats: labels(cats), skills });
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const n = (sql, ...a) => db.prepare(sql).get(...a).n;

const plural = (k) => { const a = k % 100, b = k % 10; return a > 10 && a < 15 ? "обменов" : b === 1 ? "обмен" : b >= 2 && b <= 4 ? "обмена" : "обменов"; };
const tokens = (s) => new Set(String(s || "").toLowerCase().split(/[,;\s]+/).filter((w) => w.length > 2));
const LEVELS = [0, 25, 60, 120, 220, 400], LEVEL_NAMES = ["Новичок", "Ученик", "Практик", "Наставник", "Эксперт", "Мастер"];

function memberFields(u) {
  const pick = (s, cats) => { const a = s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6); return a.length ? a : labels(cats); };
  const teach = pick(u.teach_skills, u.teach_cats), learn = pick(u.learn_skills, u.learn_cats);
  return { role: labels(u.teach_cats).slice(0, 2).join(" • "), cats: "," + J(u.teach_cats).join(",") + ",", wants: "," + J(u.learn_cats).join(",") + ",",
    teach: JSON.stringify(teach), learn: JSON.stringify(learn), ls: JSON.stringify(learn.map(() => 0)), initials: initials(u.name),
    search: [u.name, ...teach, ...learn, ...labels(u.teach_cats), ...labels(u.learn_cats)].join(" ").toLowerCase() };
}

function notify(userId, kind, text, swapId = null, refUserId = null) {
  db.prepare("INSERT INTO notifications (user_id, kind, text, swap_id, ref_user_id) VALUES (?,?,?,?,?)").run(userId, kind, text, swapId, refUserId);
}

function toMember(r, m, uid) {
  return {
    id: r.id, n: r.name, r: r.role, m, s: r.rating, e: r.exchanges, ew: r.ew, on: r.online, w: r.globe,
    t: J(r.teach), ts: r.teach_style ? J(r.teach_style) : undefined, l: J(r.learn), ls: J(r.learn_style),
    loc: r.location, a: r.reply || "", i: r.initials, rs: r.rs || "", requested: !!r.rs, sid: r.sid || null,
    own: r.user_id != null && r.user_id === uid,
  };
}

module.exports = {
  CATS, SLOTS,

  // ---- участники на сайте (только одобренные + демо) ----
  listMembers(cat, q, sort, uid) {
    const where = [], args = [uid || 0, uid || 0];
    if (CATS[cat]) { where.push("m.cats LIKE ?"); args.push(`%,${cat},%`); }
    if (q) { where.push("m.search LIKE ? ESCAPE '\\'"); args.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%"); }
    const rows = db.prepare(`SELECT m.*, (SELECT status FROM swaps s WHERE s.member_id = m.id AND s.user_id = ?) AS rs,
      (SELECT id FROM swaps s2 WHERE s2.member_id = m.id AND s2.user_id = ?) AS sid
      FROM members m ${where.length ? "WHERE " + where.join(" AND ") : ""}`).all(...args);
    const v = uid ? db.prepare("SELECT teach_cats, learn_cats FROM users WHERE id = ?").get(uid) : null;
    const vTeach = v ? J(v.teach_cats) : [], vLearn = v ? J(v.learn_cats) : [];
    const has = (str, arr) => arr.some((c) => str.includes(`,${c},`));
    const out = rows.map((r) => {
      let m = r.score;
      if (r.user_id != null) { m = 70; if (v) m = 60 + (has(r.cats, vLearn) ? 25 : 0) + (has(r.wants, vTeach) ? 14 : 0); }
      return toMember(r, m, uid);
    });
    const key = { m: "m", r: "s", e: "e" }[sort] || "m";
    return out.sort((a, b) => b[key] - a[key]);
  },
  stats() {
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
    return {
      members: (meta.members || 0) + n("SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND status = 'approved'"),
      swaps: (meta.swaps || 0) + n("SELECT COUNT(*) AS n FROM swaps"), trust: meta.trust || 98,
    };
  },

  // ---- пользователи и сессии ----
  createUser: (u) => Number(db.prepare(`INSERT INTO users (name,email,password_hash,role,status,teach_cats,teach_skills,learn_cats,learn_skills,verify_hash,verify_expires)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(u.name, u.email, u.hash, u.role || "user", u.status || "pending",
    JSON.stringify(u.teachCats || []), u.teachSkills || "", JSON.stringify(u.learnCats || []), u.learnSkills || "", u.verifyHash || null, u.verifyExpires || null).lastInsertRowid),
  resubmit(id, u) {
    db.prepare(`UPDATE users SET name=?, password_hash=?, status=?, status_note=NULL, teach_cats=?, teach_skills=?, learn_cats=?, learn_skills=?,
      verify_hash=?, verify_expires=?, created_at=CURRENT_TIMESTAMP WHERE id=?`).run(u.name, u.hash, u.status || "unverified", JSON.stringify(u.teachCats), u.teachSkills,
      JSON.stringify(u.learnCats), u.learnSkills, u.verifyHash, u.verifyExpires, id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  },
  // Email подтверждён: заявка переходит администратору (статус pending)
  verifyEmail(hash) {
    const u = db.prepare("SELECT id, name, email FROM users WHERE verify_hash = ? AND verify_expires > ? AND status = 'unverified'").get(hash, Date.now());
    if (!u) return null;
    db.prepare("UPDATE users SET status = 'pending', verify_hash = NULL, verify_expires = NULL, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(u.id);
    return { id: u.id, name: u.name, email: u.email };
  },
  userByEmail: (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email),
  adminUser: () => db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get(),
  setAdmin: (id, email, hash) => db.prepare("UPDATE users SET email = ?, password_hash = ? WHERE id = ?").run(email, hash, id),
  createSession: (token, uid, exp) => db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(token, uid, exp),
  sessionUser: (token) => db.prepare(`SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'approved'`).get(token, Date.now()),
  deleteSession: (token) => db.prepare("DELETE FROM sessions WHERE token = ?").run(token),
  purgeSessions: () => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()),

  // ---- админка: заявки ----
  notifyAdmins(text, refUserId) {
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) notify(a.id, "registration", text, null, refUserId);
  },
  listUsers: (status) => db.prepare("SELECT * FROM users WHERE role = 'user' AND status = ? ORDER BY created_at DESC, id DESC").all(status).map((u) => ({
    id: u.id, name: u.name, email: u.email, status: u.status, note: u.status_note || "", created: u.created_at,
    teach: prof(u.teach_cats, u.teach_skills), learn: prof(u.learn_cats, u.learn_skills),
  })),
  counts() {
    const c = { pending: 0, approved: 0, rejected: 0 };
    for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM users WHERE role = 'user' GROUP BY status").all()) c[r.status] = r.n;
    return c;
  },
  demoMembers: () => db.prepare("SELECT id, name, role FROM members WHERE user_id IS NULL").all(),
  deleteDemo: (id) => db.prepare("DELETE FROM members WHERE id = ? AND user_id IS NULL").run(id).changes > 0,
  approveUser(id) {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(id);
    if (!u) return false;
    const skills = (s, cats) => { const a = s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6); return a.length ? a : labels(cats); };
    const teach = skills(u.teach_skills, u.teach_cats), learn = skills(u.learn_skills, u.learn_cats);
    db.transaction(() => {
      db.prepare("UPDATE users SET status = 'approved', status_note = NULL WHERE id = ?").run(id);
      db.prepare("DELETE FROM members WHERE user_id = ?").run(id);
      db.prepare(`INSERT INTO members (user_id,name,role,score,rating,exchanges,ew,online,globe,cats,wants,teach,teach_style,learn,learn_style,location,reply,initials,search)
        VALUES (?,?,?,70,0,0,'обменов',1,1,?,?,?,NULL,?,?,'Онлайн',NULL,?,?)`).run(
        id, u.name, labels(u.teach_cats).slice(0, 2).join(" • "), "," + J(u.teach_cats).join(",") + ",", "," + J(u.learn_cats).join(",") + ",",
        JSON.stringify(teach), JSON.stringify(learn), JSON.stringify(learn.map(() => 0)), initials(u.name),
        [u.name, ...teach, ...learn, ...labels(u.teach_cats), ...labels(u.learn_cats)].join(" ").toLowerCase());
    })();
    return true;
  },
  rejectUser(id, note) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'user'").get(id);
    if (!u) return false;
    db.transaction(() => {
      db.prepare("UPDATE users SET status = 'rejected', status_note = ? WHERE id = ?").run(note || null, id);
      db.prepare("DELETE FROM members WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM swaps WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    })();
    return true;
  },

  // ---- обмены и уведомления ----
  createSwap(uid, memberId) {
    const m = db.prepare("SELECT id, user_id FROM members WHERE id = ?").get(memberId);
    if (!m) return "notfound";
    if (m.user_id === uid) return "self";
    return db.transaction(() => {
      const r = db.prepare("INSERT OR IGNORE INTO swaps (user_id, member_id) VALUES (?, ?)").run(uid, memberId);
      if (!r.changes) return "dup";
      if (m.user_id) {
        const me = db.prepare("SELECT name FROM users WHERE id = ?").get(uid);
        notify(m.user_id, "swap_request", `${me.name} предлагает вам обмен навыками`, Number(r.lastInsertRowid), uid);
      }
      return "ok";
    })();
  },
  respondSwap(uid, swapId, action, comment) {
    const s = db.prepare("SELECT s.*, m.user_id AS owner FROM swaps s JOIN members m ON m.id = s.member_id WHERE s.id = ?").get(swapId);
    if (!s || s.owner !== uid) return "notfound";
    if (s.status !== "pending") return "done";
    const status = action === "accept" ? "accepted" : "declined";
    const me = db.prepare("SELECT name FROM users WHERE id = ?").get(uid);
    db.transaction(() => {
      db.prepare("UPDATE swaps SET status = ?, comment = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, comment || null, swapId);
      db.prepare("UPDATE notifications SET read = 1 WHERE swap_id = ? AND user_id = ?").run(swapId, uid);
      notify(s.user_id, "swap_answer", `${me.name} ${status === "accepted" ? "принял(а)" : "отклонил(а)"} ваш запрос на обмен`, swapId, uid);
    })();
    return "ok";
  },
  listNotifications: (uid) => db.prepare(`SELECT n.*, s.status AS swap_status, s.comment AS swap_comment,
      u.name AS ref_name, u.email AS ref_email, u.teach_cats, u.teach_skills, u.learn_cats, u.learn_skills
    FROM notifications n LEFT JOIN swaps s ON s.id = n.swap_id LEFT JOIN users u ON u.id = n.ref_user_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`).all(uid).map((r) => ({
    id: r.id, kind: r.kind, text: r.text, read: !!r.read, time: r.created_at, swapId: r.swap_id,
    status: r.swap_status || "", comment: r.swap_comment || "",
    from: r.ref_name ? { name: r.ref_name, teach: prof(r.teach_cats, r.teach_skills), learn: prof(r.learn_cats, r.learn_skills),
      email: r.swap_status === "accepted" ? r.ref_email : undefined } : undefined,
  })),
  // ---- личный кабинет ----
  cabinet(uid) {
    const M = module.exports, u = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    return {
      profile: { name: u.name, email: u.email, teachCats: J(u.teach_cats), teachSkills: u.teach_skills, learnCats: J(u.learn_cats), learnSkills: u.learn_skills, availability: J(u.availability) },
      swaps: M.mySwaps(uid), reviews: M.reviewsFor(uid), ach: M.achievements(uid), recs: M.recommend(uid), workshops: M.listWorkshops(uid),
    };
  },
  saveProfile(uid, p) {
    db.transaction(() => {
      db.prepare("UPDATE users SET name=?, teach_cats=?, teach_skills=?, learn_cats=?, learn_skills=?, availability=? WHERE id=?")
        .run(p.name, JSON.stringify(p.teachCats), p.teachSkills, JSON.stringify(p.learnCats), p.learnSkills, JSON.stringify(p.availability), uid);
      const u = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
      if (u.status === "approved") {
        const f = memberFields(u);
        db.prepare("UPDATE members SET name=?, role=?, cats=?, wants=?, teach=?, learn=?, learn_style=?, initials=?, search=? WHERE user_id=?")
          .run(u.name, f.role, f.cats, f.wants, f.teach, f.learn, f.ls, f.initials, f.search, uid);
      }
    })();
  },
  mySwaps: (uid) => db.prepare(`SELECT s.id, s.status, s.comment, s.created_at, s.user_id AS from_id, m.user_id AS to_id, m.name AS member_name,
      (SELECT name FROM users WHERE id = s.user_id) AS from_name,
      EXISTS(SELECT 1 FROM reviews r WHERE r.swap_id = s.id AND r.author_id = ?) AS reviewed
    FROM swaps s JOIN members m ON m.id = s.member_id WHERE s.user_id = ? OR m.user_id = ? ORDER BY s.id DESC LIMIT 100`).all(uid, uid, uid).map((r) => {
    const out = r.from_id === uid;
    return { id: r.id, status: r.status, comment: r.comment || "", time: r.created_at, dir: out ? "out" : "in", partner: out ? r.member_name : r.from_name,
      canChat: r.status === "accepted" && r.to_id != null, reviewed: !!r.reviewed };
  }),

  // ---- отзывы и рейтинг ----
  refreshStats(uid) {
    const r = db.prepare("SELECT COUNT(*) AS c, AVG(rating) AS a FROM reviews WHERE target_id = ?").get(uid);
    const ex = n("SELECT COUNT(*) AS n FROM swaps s JOIN members m ON m.id = s.member_id WHERE s.status = 'accepted' AND (s.user_id = ? OR m.user_id = ?)", uid, uid);
    db.prepare("UPDATE members SET rating = ?, exchanges = ?, ew = ? WHERE user_id = ?").run(r.c ? Math.round(r.a * 10) / 10 : 0, ex, plural(ex), uid);
  },
  addReview(uid, swapId, rating, comment) {
    const partner = module.exports.chatPartner(uid, swapId);
    if (partner == null) return "notfound";
    const r = db.prepare("INSERT OR IGNORE INTO reviews (swap_id, author_id, target_id, rating, comment) VALUES (?,?,?,?,?)").run(swapId, uid, partner, rating, comment || null);
    if (!r.changes) return "dup";
    module.exports.refreshStats(partner);
    return "ok";
  },
  reviewsFor(uid) {
    const items = db.prepare(`SELECT r.rating, r.comment, r.created_at, u.name FROM reviews r JOIN users u ON u.id = r.author_id
      WHERE r.target_id = ? ORDER BY r.id DESC LIMIT 50`).all(uid).map((r) => ({ rating: r.rating, comment: r.comment || "", time: r.created_at, author: r.name }));
    const a = db.prepare("SELECT COUNT(*) AS c, AVG(rating) AS a FROM reviews WHERE target_id = ?").get(uid);
    return { items, count: a.c, avg: a.c ? Math.round(a.a * 10) / 10 : 0 };
  },

  // ---- достижения и уровни ----
  achievements(uid) {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    const ex = n("SELECT COUNT(*) AS n FROM swaps s JOIN members m ON m.id = s.member_id WHERE s.status = 'accepted' AND (s.user_id = ? OR m.user_id = ?)", uid, uid);
    const rv = db.prepare("SELECT COUNT(*) AS c, AVG(rating) AS a FROM reviews WHERE target_id = ?").get(uid);
    const hosted = n("SELECT COUNT(*) AS n FROM workshops WHERE host_id = ?", uid);
    const msgs = n("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?", uid);
    const full = !!(u.teach_skills && u.learn_skills && J(u.availability).length);
    const star = rv.c >= 3 && rv.a >= 4.5;
    const points = ex * 10 + rv.c * 5 + (star ? 20 : 0) + hosted * 15 + Math.floor(Math.min(msgs, 100) / 5) + (full ? 10 : 0);
    let i = 0; LEVELS.forEach((t, k) => { if (points >= t) i = k; });
    const next = LEVELS[i + 1];
    return {
      points, level: { n: i + 1, name: LEVEL_NAMES[i], next: next ?? null, pct: next ? Math.round(((points - LEVELS[i]) / (next - LEVELS[i])) * 100) : 100 },
      badges: [
        { title: "Первый обмен", desc: "Примите или проведите первый обмен", ok: ex >= 1 },
        { title: "Опытный наставник", desc: "5 успешных обменов", ok: ex >= 5 },
        { title: "Звезда сообщества", desc: "3 отзыва со средней оценкой от 4.5", ok: star },
        { title: "Организатор", desc: "Создайте мастер-класс", ok: hosted >= 1 },
        { title: "Общительный", desc: "Отправьте 20 сообщений", ok: msgs >= 20 },
        { title: "Полный профиль", desc: "Заполните навыки и свободное время", ok: full },
      ],
    };
  },

  // ---- умный подбор партнёров 2.0: интересы + навыки + свободное время + доверие ----
  recommend(uid) {
    const me = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    const myTeach = J(me.teach_cats), myLearn = J(me.learn_cats), myAv = J(me.availability);
    const asked = Object.fromEntries(db.prepare("SELECT member_id, status FROM swaps WHERE user_id = ?").all(uid).map((r) => [r.member_id, r.status]));
    const rows = db.prepare(`SELECT u.*, m.id AS member_id, m.rating AS rating, m.initials AS ini FROM users u JOIN members m ON m.user_id = u.id
      WHERE u.role = 'user' AND u.status = 'approved' AND u.id != ?`).all(uid);
    const both = (a, b) => a.filter((x) => b.includes(x));
    const shared = (a, b) => [...a].filter((x) => b.has(x));
    return rows.map((o) => {
      const a = both(myLearn, J(o.teach_cats)), b = both(myTeach, J(o.learn_cats));
      const c = shared(tokens(me.learn_skills), tokens(o.teach_skills)), dd = shared(tokens(me.teach_skills), tokens(o.learn_skills));
      const t = both(myAv, J(o.availability));
      const interest = (a.length ? 30 : 0) + (b.length ? 30 : 0) + Math.min(10, 5 * (c.length + dd.length));
      if (!interest) return null;
      const score = Math.min(99, interest + Math.min(20, t.length * 10) + (o.rating ? Math.round(o.rating * 2) : 0));
      const reasons = [];
      if (a.length) reasons.push("Учит то, что вы хотите: " + a.map((x) => CATS[x]).join(", "));
      if (b.length) reasons.push("Хочет то, чему вы учите: " + b.map((x) => CATS[x]).join(", "));
      if (c.length || dd.length) reasons.push("Совпали навыки: " + [...c, ...dd].slice(0, 4).join(", "));
      if (t.length) reasons.push("Удобное время: " + t.map((x) => SLOTS[x]).join(", "));
      return { memberId: o.member_id, name: o.name, initials: o.ini, score, reasons, status: asked[o.member_id] || "" };
    }).filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 6);
  },

  // ---- групповые мастер-классы ----
  listWorkshops(uid) {
    const since = new Date(Date.now() - 2 * 3600e3).toISOString();
    return db.prepare(`SELECT w.*, u.name AS host_name, (SELECT COUNT(*) FROM workshop_members x WHERE x.workshop_id = w.id) AS joined,
        EXISTS(SELECT 1 FROM workshop_members x WHERE x.workshop_id = w.id AND x.user_id = ?) AS me_in
      FROM workshops w JOIN users u ON u.id = w.host_id WHERE w.starts_at >= ? ORDER BY w.starts_at ASC LIMIT 100`).all(uid, since).map((w) => {
      const mine = w.host_id === uid;
      return { id: w.id, title: w.title, description: w.description, cat: CATS[w.cat] || "Другое", startsAt: w.starts_at, capacity: w.capacity, joined: w.joined,
        hostName: w.host_name, mine, joinedMe: !!w.me_in, link: mine || w.me_in ? w.link || "" : "", hasLink: !!w.link };
    });
  },
  createWorkshop: (uid, w) => db.prepare("INSERT INTO workshops (host_id, title, description, cat, starts_at, capacity, link) VALUES (?,?,?,?,?,?,?)")
    .run(uid, w.title, w.desc, w.cat, w.startsAt, w.cap, w.link || null),
  joinWorkshop(uid, id) {
    const w = db.prepare("SELECT * FROM workshops WHERE id = ?").get(id);
    if (!w) return "notfound";
    if (w.host_id === uid) return "host";
    if (w.starts_at < new Date(Date.now() - 3600e3).toISOString()) return "past";
    const already = db.prepare("SELECT 1 FROM workshop_members WHERE workshop_id = ? AND user_id = ?").get(id, uid);
    if (!already && n("SELECT COUNT(*) AS n FROM workshop_members WHERE workshop_id = ?", id) >= w.capacity) return "full";
    db.prepare("INSERT OR IGNORE INTO workshop_members (workshop_id, user_id) VALUES (?, ?)").run(id, uid);
    return "ok";
  },
  leaveWorkshop: (uid, id) => db.prepare("DELETE FROM workshop_members WHERE workshop_id = ? AND user_id = ?").run(id, uid),
  deleteWorkshop: (uid, id, isAdmin) => db.prepare("DELETE FROM workshops WHERE id = ? AND (host_id = ? OR ? = 1)").run(id, uid, isAdmin ? 1 : 0).changes > 0,

  // ---- видеозвонок (WebRTC): сервер только передаёт сигналы между двумя участниками ----
  addSignal(uid, swapId, kind, data) {
    if (module.exports.chatPartner(uid, swapId) == null) return 0;
    db.prepare("DELETE FROM call_signals WHERE created_at < datetime('now', '-1 day')").run();
    if (kind === "offer") db.prepare("DELETE FROM call_signals WHERE swap_id = ?").run(swapId);
    return Number(db.prepare("INSERT INTO call_signals (swap_id, sender_id, kind, data) VALUES (?,?,?,?)").run(swapId, uid, kind, data).lastInsertRowid);
  },
  getSignals(uid, swapId, after) {
    if (module.exports.chatPartner(uid, swapId) == null) return null;
    return db.prepare("SELECT id, kind, data FROM call_signals WHERE swap_id = ? AND sender_id != ? AND id > ? ORDER BY id ASC LIMIT 100").all(swapId, uid, after || 0);
  },
  incomingCall(uid) {
    const r = db.prepare(`SELECT cs.id, cs.swap_id, cs.data, cs.sender_id FROM call_signals cs
      JOIN (SELECT swap_id, MAX(id) AS mid FROM call_signals WHERE kind != 'ice' GROUP BY swap_id) l ON l.mid = cs.id
      JOIN swaps s ON s.id = cs.swap_id JOIN members m ON m.id = s.member_id
      WHERE cs.kind = 'offer' AND cs.sender_id != ? AND s.status = 'accepted' AND (s.user_id = ? OR m.user_id = ?)
        AND cs.created_at > datetime('now', '-45 seconds') ORDER BY cs.id DESC LIMIT 1`).get(uid, uid, uid);
    if (!r) return null;
    const from = db.prepare("SELECT name FROM users WHERE id = ?").get(r.sender_id);
    return { swapId: r.swap_id, offerId: r.id, from: from ? from.name : "Участник", data: r.data };
  },

  // ---- чат между участниками принятого обмена ----
  chatPartner(uid, swapId) {
    const s = db.prepare("SELECT s.user_id AS a, m.user_id AS b FROM swaps s JOIN members m ON m.id = s.member_id WHERE s.id = ? AND s.status = 'accepted'").get(swapId);
    if (!s || s.b == null) return null;
    return s.a === uid ? s.b : s.b === uid ? s.a : null;
  },
  chatMessages(uid, swapId, after) {
    if (module.exports.chatPartner(uid, swapId) == null) return null;
    db.prepare("UPDATE messages SET read = 1 WHERE swap_id = ? AND sender_id != ? AND read = 0").run(swapId, uid);
    return db.prepare("SELECT id, sender_id, body, created_at FROM messages WHERE swap_id = ? AND id > ? ORDER BY id ASC LIMIT 300").all(swapId, after || 0)
      .map((m) => ({ id: m.id, mine: m.sender_id === uid, body: m.body, time: m.created_at }));
  },
  sendMessage(uid, swapId, body) {
    if (module.exports.chatPartner(uid, swapId) == null) return null;
    const r = db.prepare("INSERT INTO messages (swap_id, sender_id, body) VALUES (?, ?, ?)").run(swapId, uid, body);
    const m = db.prepare("SELECT id, body, created_at FROM messages WHERE id = ?").get(Number(r.lastInsertRowid));
    return { id: m.id, mine: true, body: m.body, time: m.created_at };
  },
  listChats(uid) {
    const rows = db.prepare(`SELECT s.id AS swap_id,
        CASE WHEN s.user_id = ? THEN m.user_id ELSE s.user_id END AS partner_id,
        (SELECT body FROM messages WHERE swap_id = s.id ORDER BY id DESC LIMIT 1) AS last_body,
        (SELECT created_at FROM messages WHERE swap_id = s.id ORDER BY id DESC LIMIT 1) AS last_time,
        (SELECT COUNT(*) FROM messages WHERE swap_id = s.id AND sender_id != ? AND read = 0) AS unread,
        COALESCE((SELECT MAX(id) FROM messages WHERE swap_id = s.id), 0) AS last_id
      FROM swaps s JOIN members m ON m.id = s.member_id
      WHERE s.status = 'accepted' AND m.user_id IS NOT NULL AND (s.user_id = ? OR m.user_id = ?)
      ORDER BY last_id DESC, s.answered_at DESC`).all(uid, uid, uid, uid);
    const items = rows.map((r) => {
      const p = db.prepare("SELECT name FROM users WHERE id = ?").get(r.partner_id);
      const name = p ? p.name : "Участник";
      return { swapId: r.swap_id, partner: { name, initials: initials(name) }, last: r.last_body ? { body: r.last_body, time: r.last_time } : null, unread: r.unread };
    });
    return { items, unread: items.reduce((t, c) => t + c.unread, 0) };
  },
  markRead: (uid) => db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND kind != 'swap_request'").run(uid),
};
