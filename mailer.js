// Отправка писем через SMTP (Gmail и др.). Если SMTP не настроен — ссылка выводится в окно сервера
const { SMTP_USER, SMTP_PASS } = process.env;
const port = Number(process.env.SMTP_PORT) || 465;
let transport = null;

if (SMTP_USER && SMTP_PASS) {
  try {
    transport = require("nodemailer").createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com", port, secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS.replace(/\s+/g, "") },
    });
  } catch (e) { console.error("Почта не запущена: выполните npm install (нужен пакет nodemailer)."); }
}

async function sendMail(to, subject, html, text) {
  if (!transport) {
    console.log(`\n[Почта не настроена] Письмо для ${to}\nТема: ${subject}\n${text}\n`);
    return false;
  }
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || `SkillSwap <${SMTP_USER}>`, to, subject, text, html });
    return true;
  } catch (e) {
    console.error("Ошибка отправки письма:", e.message);
    console.log(`Письмо для ${to} не ушло. Текст:\n${text}\n`);
    return false;
  }
}
module.exports = { sendMail };
