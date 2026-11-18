const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { promisify } = require("util");
const store = require("./db");
const { sendMail } = require("./mailer");

const scrypt = promisify(crypto.scrypt);
const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1); // сайт за прокси хостинга
app.use(express.json({ limit: "64kb" }));

// ---------- пароли и сессии ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
async function checkPassword(pw, stored) {
  const [, salt, hash] = stored.split("$");
  const key = await scrypt(pw, Buffer.from(salt, "hex"), 64);
  return crypto.timingSafeEqual(key, Buffer.from(hash, "hex"));
}
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const siteUrl = () => (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DUMMY_HASH = "scrypt$" + "00".repeat(16) + "$" + "00".repeat(64);

const cookie = (v, maxAgeSec) =>
  `sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const tokenOf = (req) => ((req.headers.cookie || "").match(/(?:^|;\s*)sid=([a-f0-9]{64})/) || [])[1];

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  store.createSession(token, userId, Date.now() + SESSION_MS);
  res.setHeader("Set-Cookie", cookie(token, SESSION_MS / 1000));
}
app.use((req, res, next) => {
  const t = tokenOf(req);
  req.user = t ? store.sessionUser(t) || null : null;
  next();
});
const needAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Нужно войти в аккаунт" }));
const needAdmin = (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Нужно войти" }) : req.user.role === "admin" ? next() : res.status(403).json({ error: "Только для администратора" });

const tries = new Map();
function limiter(req, res, next) {
  const now = Date.now(), e = tries.get(req.ip);
  if (!e || e.reset < now) tries.set(req.ip, { n: 1, reset: now + 15 * 60 * 1000 });
  else if (++e.n > 10) return res.status(429).json({ error: "Слишком много попыток. Попробуйте позже" });
  next();
}

// ---------- регистрация (заявка) и вход ----------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (typeof v === "string" ? v.trim() : "");
const catList = (v) => (Array.isArray(v) ? [...new Set(v.filter((c) => typeof c === "string" && store.CATS[c]))] : []);
const skills = (v) => str(v).replace(/\s+/g, " ").slice(0, 200);

app.get("/api/categories", (req, res) => res.json(Object.entries(store.CATS).map(([key, label]) => ({ key, label }))));

app.post("/api/auth/register", limiter, async (req, res) => {
  const name = str(req.body.name), email = str(req.body.email).toLowerCase(), password = req.body.password;
  const teachCats = catList(req.body.teachCats), learnCats = catList(req.body.learnCats);
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "Имя должно быть от 2 до 60 символов" });
  if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: "Введите корректный email" });
  if (typeof password !== "string" || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: "Пароль должен быть от 8 до 128 символов" });
  if (!teachCats.length || !learnCats.length)
    return res.status(400).json({ error: "Выберите хотя бы одну категорию в обоих списках" });

  const existing = store.userByEmail(email);
  if (existing && existing.status === "pending") return res.status(409).json({ error: "Заявка с этим email уже отправлена и ждёт проверки" });
  if (existing && !["rejected", "unverified"].includes(existing.status)) return res.status(409).json({ error: "Этот email уже зарегистрирован" });

  // Подтверждение email по письму включается переменной REQUIRE_EMAIL_VERIFY=1.
  // Пока она не задана, заявка сразу уходит администратору.
  const verify = process.env.REQUIRE_EMAIL_VERIFY === "1";
  const token = verify ? crypto.randomBytes(32).toString("hex") : null;
  const data = { name, email, hash: await hashPassword(password), teachCats, learnCats, teachSkills: skills(req.body.teachSkills),
    learnSkills: skills(req.body.learnSkills), status: verify ? "unverified" : "pending",
    verifyHash: token ? sha(token) : null, verifyExpires: token ? Date.now() + 24 * 60 * 60 * 1000 : null };
  let id;
  if (existing) { store.resubmit(existing.id, data); id = existing.id; } else id = store.createUser(data);
  if (!verify) {
    store.notifyAdmins(`Новая заявка: ${name} (${email})`, id);
    return res.status(201).json({ pending: true });
  }

  const link = `${siteUrl()}/api/auth/verify?token=${token}`;
  const text = `Здравствуйте, ${name}!\n\nВы зарегистрировались на SkillSwap. Чтобы отправить заявку администратору, подтвердите email по ссылке (действует 24 часа):\n${link}\n\nЕсли это были не вы, просто проигнорируйте письмо.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1a2040"><h2>Подтвердите email</h2><p>Здравствуйте, ${escHtml(name)}!</p>
    <p>Вы зарегистрировались на SkillSwap. Нажмите кнопку, чтобы подтвердить email, и ваша заявка уйдёт администратору на проверку.</p>
    <p><a href="${link}" style="display:inline-block;background:#6a5af0;color:#fff;padding:14px 26px;border-radius:10px;text-decoration:none;font-weight:bold">Подтвердить email</a></p>
    <p style="color:#6b7391;font-size:13px">Ссылка действует 24 часа. Если это были не вы, проигнорируйте письмо.</p></div>`;
  const mailed = await sendMail(email, "Подтвердите email на SkillSwap", html, text);
  res.status(201).json({ unverified: true, mailed });
});

app.post("/api/auth/login", limiter, async (req, res) => {
  const email = str(req.body.email).toLowerCase(), password = req.body.password;
  const u = typeof password === "string" ? store.userByEmail(email) : null;
  const ok = await checkPassword(typeof password === "string" ? password : "", u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: "Неверный email или пароль" });
  if (u.status === "unverified")
    return res.status(403).json({ error: "Подтвердите email: мы отправили письмо со ссылкой на ваш адрес. После подтверждения заявка уйдёт администратору." });
  if (u.status === "pending") return res.status(403).json({ error: "Ваша заявка ещё на рассмотрении у администратора. Войти можно после одобрения." });
  if (u.status === "rejected")
    return res.status(403).json({ error: `Администратор отклонил вашу заявку${u.status_note ? ": " + u.status_note : ""}. Вы можете зарегистрироваться заново.` });
  startSession(res, u.id);
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role } });
});

// Ссылка из письма: подтверждает email и отправляет заявку администратору
app.get("/api/auth/verify", (req, res) => {
  const t = typeof req.query.token === "string" && /^[a-f0-9]{64}$/.test(req.query.token) ? req.query.token : null;
  const u = t && store.verifyEmail(sha(t));
  if (u) store.notifyAdmins(`Новая заявка: ${u.name} (${u.email}), email подтверждён`, u.id);
  res.redirect(u ? "/?verified=1" : "/?verified=0");
});

app.post("/api/auth/logout", (req, res) => {
  const t = tokenOf(req);
  if (t) store.deleteSession(t);
  res.setHeader("Set-Cookie", cookie("", 0));
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));

// ---------- участники, обмены, уведомления ----------
app.get("/api/members", (req, res) => {
  const { category = "all", q = "", sort = "m" } = req.query;
  res.json(store.listMembers(String(category), String(q).trim().toLowerCase(), String(sort), req.user && req.user.id));
});

app.post("/api/swaps", needAuth, (req, res) => {
  const r = store.createSwap(req.user.id, Number(req.body.memberId));
  if (r === "notfound") return res.status(404).json({ error: "Участник не найден" });
  if (r === "self") return res.status(400).json({ error: "Нельзя предложить обмен самому себе" });
  if (r === "dup") return res.status(409).json({ error: "Запрос уже отправлен" });
  res.status(201).json({ ok: true });
});

app.post("/api/swaps/:id/respond", needAuth, (req, res) => {
  const action = req.body.action;
  if (action !== "accept" && action !== "decline") return res.status(400).json({ error: "Неверное действие" });
  const r = store.respondSwap(req.user.id, Number(req.params.id), action, str(req.body.comment).slice(0, 500));
  if (r === "notfound") return res.status(404).json({ error: "Запрос не найден" });
  if (r === "done") return res.status(409).json({ error: "На этот запрос уже ответили" });
  if (action === "accept") { // обновляем число обменов у обоих участников
    store.refreshStats(req.user.id);
    const partner = store.chatPartner(req.user.id, Number(req.params.id));
    if (partner) store.refreshStats(partner);
  }
  res.json({ ok: true });
});

app.get("/api/notifications", needAuth, (req, res) => res.json({ items: store.listNotifications(req.user.id) }));
app.post("/api/notifications/read", needAuth, (req, res) => { store.markRead(req.user.id); res.json({ ok: true }); });

// ---------- чат между участниками принятого обмена ----------
const msgTimes = new Map();
function msgLimiter(req, res, next) {
  const now = Date.now(), e = msgTimes.get(req.user.id);
  if (!e || e.reset < now) msgTimes.set(req.user.id, { n: 1, reset: now + 30000 });
  else if (++e.n > 20) return res.status(429).json({ error: "Слишком много сообщений. Подождите немного" });
  next();
}
app.get("/api/chats", needAuth, (req, res) => res.json(store.listChats(req.user.id)));
app.get("/api/chats/:id/messages", needAuth, (req, res) => {
  const items = store.chatMessages(req.user.id, Number(req.params.id), Number(req.query.after) || 0);
  items ? res.json({ items }) : res.status(404).json({ error: "Чат не найден" });
});
app.post("/api/chats/:id/messages", needAuth, msgLimiter, (req, res) => {
  const body = str(req.body.body).slice(0, 1000);
  if (!body) return res.status(400).json({ error: "Введите сообщение" });
  const m = store.sendMessage(req.user.id, Number(req.params.id), body);
  m ? res.status(201).json(m) : res.status(404).json({ error: "Чат не найден" });
});

// ---------- личный кабинет, отзывы, мастер-классы, видеозвонки ----------
const limiterFor = (max, ms) => { const m = new Map(); return (req, res, next) => {
  const now = Date.now(), e = m.get(req.user.id);
  if (!e || e.reset < now) m.set(req.user.id, { n: 1, reset: now + ms }); else if (++e.n > max) return res.status(429).json({ error: "Слишком много запросов. Подождите немного" });
  next(); }; };
const callLimiter = limiterFor(600, 60000), actLimiter = limiterFor(60, 60000);

app.get("/api/me/cabinet", needAuth, (req, res) => res.json(store.cabinet(req.user.id)));

app.put("/api/me/profile", needAuth, actLimiter, (req, res) => {
  const name = str(req.body.name), teachCats = catList(req.body.teachCats), learnCats = catList(req.body.learnCats);
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "Имя должно быть от 2 до 60 символов" });
  if (!teachCats.length || !learnCats.length) return res.status(400).json({ error: "Выберите хотя бы одну категорию в обоих списках" });
  const availability = Array.isArray(req.body.availability) ? [...new Set(req.body.availability.filter((k) => store.SLOTS[k]))] : [];
  store.saveProfile(req.user.id, { name, teachCats, learnCats, teachSkills: skills(req.body.teachSkills), learnSkills: skills(req.body.learnSkills), availability });
  res.json({ ok: true });
});

app.post("/api/swaps/:id/review", needAuth, actLimiter, (req, res) => {
  const rating = Math.round(Number(req.body.rating));
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: "Поставьте оценку от 1 до 5" });
  const r = store.addReview(req.user.id, Number(req.params.id), rating, str(req.body.comment).slice(0, 500));
  if (r === "notfound") return res.status(404).json({ error: "Отзыв можно оставить только по принятому обмену" });
  if (r === "dup") return res.status(409).json({ error: "Вы уже оставили отзыв по этому обмену" });
  res.status(201).json({ ok: true });
});

const URL_OK = /^https?:\/\/[^\s]{3,300}$/i;
app.post("/api/workshops", needAuth, actLimiter, (req, res) => {
  const title = str(req.body.title), desc = str(req.body.description).slice(0, 500), link = str(req.body.link);
  const cat = store.CATS[req.body.cat] ? req.body.cat : "other", cap = Math.round(Number(req.body.capacity)), when = new Date(req.body.startsAt);
  if (title.length < 3 || title.length > 80) return res.status(400).json({ error: "Название должно быть от 3 до 80 символов" });
  if (!(cap >= 2 && cap <= 100)) return res.status(400).json({ error: "Мест должно быть от 2 до 100" });
  if (isNaN(when) || when < Date.now() || when > Date.now() + 366 * 864e5) return res.status(400).json({ error: "Выберите дату в будущем (не дальше года)" });
  if (link && !URL_OK.test(link)) return res.status(400).json({ error: "Ссылка должна начинаться с http:// или https://" });
  store.createWorkshop(req.user.id, { title, desc, cat, cap, startsAt: when.toISOString(), link });
  res.status(201).json({ ok: true });
});
app.post("/api/workshops/:id/join", needAuth, actLimiter, (req, res) => {
  const r = store.joinWorkshop(req.user.id, Number(req.params.id));
  const err = { notfound: [404, "Мастер-класс не найден"], host: [400, "Вы организатор этого мастер-класса"], past: [400, "Мастер-класс уже прошёл"], full: [409, "Мест больше нет"] }[r];
  err ? res.status(err[0]).json({ error: err[1] }) : res.json({ ok: true });
});
app.post("/api/workshops/:id/leave", needAuth, (req, res) => { store.leaveWorkshop(req.user.id, Number(req.params.id)); res.json({ ok: true }); });
app.delete("/api/workshops/:id", needAuth, (req, res) =>
  store.deleteWorkshop(req.user.id, Number(req.params.id), req.user.role === "admin") ? res.json({ ok: true }) : res.status(404).json({ error: "Не найдено" }));

const CALL_KINDS = ["offer", "answer", "ice", "hangup"];
app.post("/api/chats/:id/call", needAuth, callLimiter, (req, res) => {
  const kind = req.body.kind, data = typeof req.body.data === "string" ? req.body.data : "{}";
  if (!CALL_KINDS.includes(kind) || data.length > 40000) return res.status(400).json({ error: "Некорректный сигнал" });
  const id = store.addSignal(req.user.id, Number(req.params.id), kind, data);
  id ? res.status(201).json({ id }) : res.status(404).json({ error: "Чат не найден" });
});
app.get("/api/chats/:id/call", needAuth, callLimiter, (req, res) => {
  const items = store.getSignals(req.user.id, Number(req.params.id), Number(req.query.after) || 0);
  items ? res.json({ items }) : res.status(404).json({ error: "Чат не найден" });
});
app.get("/api/calls/incoming", needAuth, callLimiter, (req, res) => res.json({ call: store.incomingCall(req.user.id) }));

app.get("/api/stats", (req, res) => res.json(store.stats()));

// ---------- админка ----------
app.get("/admin", (req, res) =>
  req.user && req.user.role === "admin" ? res.sendFile(path.join(__dirname, "private", "admin.html")) : res.redirect("/"));

app.get("/api/admin/users", needAdmin, (req, res) => {
  const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending";
  res.json({ items: store.listUsers(status), demo: status === "approved" ? store.demoMembers() : [], counts: store.counts() });
});
app.post("/api/admin/users/:id/approve", needAdmin, (req, res) =>
  store.approveUser(Number(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "Пользователь не найден" }));
app.post("/api/admin/users/:id/reject", needAdmin, (req, res) =>
  store.rejectUser(Number(req.params.id), str(req.body.reason).slice(0, 300)) ? res.json({ ok: true }) : res.status(404).json({ error: "Пользователь не найден" }));
app.delete("/api/admin/members/:id", needAdmin, (req, res) =>
  store.deleteDemo(Number(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "Не найден" }));

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (req, res) => res.status(404).json({ error: "Не найдено" }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: "Некорректный запрос" }));

// ---------- учётная запись администратора ----------
(async () => {
  try {
    const envEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const envPw = process.env.ADMIN_PASSWORD;
    const goodPw = typeof envPw === "string" && envPw.length >= 8;
    const admin = store.adminUser();
    if (!admin) {
      const email = envEmail || "admin@skillswap.local";
      const pw = goodPw ? envPw : crypto.randomBytes(9).toString("base64url");
      store.createUser({ name: "Администратор", email, hash: await hashPassword(pw), role: "admin", status: "approved" });
      console.log(`\n=== Создан администратор ===\nEmail:  ${email}\nПароль: ${goodPw ? "(из переменной ADMIN_PASSWORD)" : pw}\nАдминка: http://localhost:${PORT}/admin\n============================\n`);
    } else if (envEmail || goodPw) {
      store.setAdmin(admin.id, envEmail || admin.email, goodPw ? await hashPassword(envPw) : admin.password_hash);
      console.log("Данные администратора обновлены из ADMIN_EMAIL / ADMIN_PASSWORD");
    }
  } catch (e) { console.error("Не удалось настроить администратора:", e.message); }
})();

setInterval(store.purgeSessions, 60 * 60 * 1000).unref();
store.purgeSessions();
app.listen(PORT, () => console.log(`SkillSwap: http://localhost:${PORT}`));
