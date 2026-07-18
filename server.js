// RX WA v2.0 — multi-tenant WhatsApp platform with Inbox + Login + Email alerts
// Official Meta Cloud API (zero ban risk). Self-hosted, no SaaS subscription.
// LLM-free reply engine (local JSON store + fuse.js). Per-client login + staff inbox + email alert.

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');
require('dotenv').config();

const app = express();
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.set('Content-Type', 'text/html; charset=utf-8'); next(); });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'RxWa@2026!SecureVerify';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RxWa@2026!Admin';
const API_VERSION = process.env.WA_API_VERSION || 'v19.0';
const APP_SECRET = process.env.META_APP_SECRET || '';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'store.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { clients: [], qa: [], messages: [], flows: {}, misses: {}, users: [] }; }
}
function save(d) { try { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); } catch (e) {} }
let _db = load();

function boot() {
  if (!_db.clients.find(c => c.id === 'halat')) {
    _db.clients.push({ id: 'halat', name: 'هالات', phone_id: process.env.HALAT_PHONE_ID || 'HALATID', wa_token: process.env.HALAT_WA_TOKEN || 'demo', flow: 'qa', owner_email: process.env.ALERT_EMAIL || '' });
  }
  if (!_db.qa.length) {
    try {
      const qa = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa.json'), 'utf8'));
      _db.qa = qa.map(q => ({ client_id: q.client_id || 'halat', question: q.question, keywords: q.keywords, reply: q.reply }));
      console.log(`[BOOT] زرع ${_db.qa.length} سؤال من qa.json ✅`);
    } catch (e) { console.log('[BOOT] تعذّر زرع qa:', e.message); }
  }
  // default owner user (admin) — password = ADMIN_PASSWORD (hashed)
  if (!_db.users.find(u => u.username === 'admin')) {
    _db.users.push({ username: 'admin', client_id: 'halat', password: bcrypt.hashSync(ADMIN_PASSWORD, 10), role: 'owner', email: process.env.ALERT_EMAIL || '' });
  }
  save(_db);
  console.log(`[BOOT] جاهز: ${_db.clients.length} عميل، ${_db.qa.length} سؤال، ${_db.users.length} مستخدم`);
}
boot();

// ---------- session ----------
app.use(session({
  secret: process.env.SESSION_SECRET || 'RxWaSession2026',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 }
}));

const requireLogin = (req, res, next) => {
  if (req.session && req.session.user) return next();
  return res.status(401).send('🔒 سجّل الدخول');
};
const requireOwnerOf = (clientId) => (req, res, next) => {
  if (req.session.user && (req.session.user.role === 'owner' || req.session.user.client_id === clientId)) return next();
  return res.status(403).send('🔒 غير مصرح');
};

const getClientByPhone = (phoneId) => _db.clients.find(c => c.phone_id === phoneId) || null;
const logMsg = (cid, from, dir, text) => {
  _db.messages.push({ client_id: cid, from_num: from, direction: dir, text, at: new Date().toISOString() });
  if (_db.messages.length > 500) _db.messages = _db.messages.slice(-500);
  save(_db);
};

// ---------- email alert ----------
let _mailer = null;
function mailer() {
  if (_mailer) return _mailer;
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASS) return null;
  _mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.ALERT_EMAIL, pass: process.env.ALERT_EMAIL_PASS }
  });
  return _mailer;
}
async function alertStaff(client, from, text) {
  const to = client.owner_email || process.env.ALERT_EMAIL;
  if (!to) return;
  const t = mailer();
  if (!t) return;
  try {
    await t.sendMail({
      from: process.env.ALERT_EMAIL,
      to,
      subject: `🔔 طلب تواصل مع موظف — ${client.name}`,
      text: `عميل طلب التواصل مع موظف.\n\nرقم العميل: ${from}\nرسالته: ${text}\n\nرد عليه من لوحة التحكم:\nhttps://${process.env.RENDER_EXTERNAL_URL || 'rx-wa-yn2j.onrender.com'}/inbox`
    });
    console.log('[EMAIL] أرسل تنبيه إلى', to);
  } catch (e) { console.error('[EMAIL] خطأ:', e.message); }
}

// ---------- reply engine ----------
function findReply(client, text) {
  const rows = _db.qa.filter(q => q.client_id === client.id);
  if (!rows.length) return null;
  const lower = text.toLowerCase();
  for (const r of rows) {
    const keys = (r.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keys.some(k => lower.includes(k))) return r.reply;
  }
  const fuse = new Fuse(rows, { keys: ['question', 'keywords'], threshold: 0.5 });
  const hit = fuse.search(text);
  if (hit.length) return hit[0].item.reply;
  return null;
}

// ---------- webhook verify ----------
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ---------- receive ----------
app.post('/webhook', (req, res) => {
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(JSON.stringify(req.body)).digest('hex');
      if (sig !== expected) return res.sendStatus(401);
    }
  }
  if (!req.body || req.body.object !== 'whatsapp_business_account') return res.sendStatus(200);
  (async () => {
    for (const entry of (req.body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const phoneId = value.metadata && value.metadata.phone_number_id;
        const client = getClientByPhone(phoneId);
        if (!client) continue;
        for (const m of (value.messages || [])) {
          const from = m.from;
          const text = (m.text && m.text.body || '').trim();
          const hasImage = !!(m.image || m.document || m.video);
          logMsg(client.id, from, 'in', text || '[صورة]');
          await handleMessage(client, from, text, hasImage);
        }
      }
    }
    res.sendStatus(200);
  })();
});

// ---------- send ----------
async function sendText(client, to, text) {
  logMsg(client.id, to, 'out', text);
  if (!client.wa_token || client.wa_token === 'demo' || !client.phone_id) {
    console.log(`[ROUTE] ${client.name} -> ${to}: ${text}`); return;
  }
  const url = `https://graph.facebook.com/${API_VERSION}/${client.phone_id}/messages`;
  try {
    await axios.post(url, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${client.wa_token}` } });
  } catch (e) { console.error('send error:', e.response && e.response.data || e.message); }
}

// ---------- reply logic ----------
async function handleMessage(client, from, text, hasImage) {
  console.log(`[ROUTE] ${client.name} <- ${from}: "${text}"`);
  const lower = text.toLowerCase();
  const flow = _db.flows[from];
  if (flow && flow.step) {
    if (lower.includes('إلغاء') || lower.includes('موظف') || lower.includes('اتصال')) {
      delete _db.flows[from]; delete _db.misses[from]; save(_db);
      return sendText(client, from, '🙋 تم إلغاء الطلب. تتواصل معاك هالات على 966579591669.');
    }
    if (flow.step === 'await_order') {
      _db.flows[from] = { step: 'await_photo', order: text.trim() }; save(_db);
      return sendText(client, from, '📸 ممتاز. الآن أرسل **صورة واضحة للتلف** (التقط صورة للمنتج التالف) ونرفع بلاغ التعويض لك.');
    }
    if (flow.step === 'await_photo') {
      if (!hasImage) return sendText(client, from, '📸 نحتاج صورة للتلف عشان نرفع البلاغ. أرسل صورة واضحة للمنتج.');
      delete _db.flows[from]; delete _db.misses[from]; save(_db);
      return sendText(client, from, `✅ استلمنا بلاغك (رقم الطلب: ${flow.order} + الصورة). فريق هالات يراجع ويتواصل معاك خلال 24 ساعة. أو تواصل مباشرة 966579591669.`);
    }
  }
  if (!text || /^(مرحبا|السلام|قائمة|السلام عليكم|start)/.test(lower)) {
    delete _db.misses[from]; save(_db);
    return sendText(client, from, `👋 أهلاً وسهلاً في *${client.name}*!\n\nاكتب سؤالك وسنرد عليك تلقائياً، أو اكتب "موظف" للتواصل مع أحد الفريق.`);
  }
  if (lower.includes('موظف') || lower.includes('اتصال')) {
    delete _db.misses[from]; save(_db);
    await alertStaff(client, from, text);
    return sendText(client, from, '🙋 فريقنا يتواصل معاك قريباً. أو تواصل على 966579591669.');
  }
  if (lower.includes('تالف') || lower.includes('كسر') || lower.includes('تلف') || lower.includes('ضرر') || lower.includes('مكسور')) {
    _db.flows[from] = { step: 'await_order', order: '' }; save(_db);
    delete _db.misses[from]; save(_db);
    return sendText(client, from, '⚠️ نأسف للإزعاج! لرفع بلاغ تعويض، أرسل **رقم طلبك** (مثلاً #1234).');
  }
  const reply = findReply(client, text);
  if (reply) {
    delete _db.misses[from]; save(_db);
    return sendText(client, from, reply);
  }
  const miss = (_db.misses[from] || 0) + 1;
  _db.misses[from] = miss; save(_db);
  if (miss >= 3) {
    delete _db.misses[from]; save(_db);
    await alertStaff(client, from, text);
    return sendText(client, from, '🙋 يبدو أن سؤالك خارج نطاق المعرفة الحالية. تواصل مباشرة مع موظف هالات على 966579591669 أو info@Halat.sa وسيساعدونك فوراً.');
  }
  return sendText(client, from, '🤖 ما قدرت أفهم سؤالك. اكتب كلمات أوضح، أو "موظف" للتواصل المباشر.');
}

// ---------- auth routes ----------
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = _db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.password)) return res.status(401).send('🔒 خطأ باسم المستخدم أو كلمة السر');
  req.session.user = { username: user.username, client_id: user.client_id, role: user.role, email: user.email };
  res.redirect('/inbox');
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// ---------- inbox (per-client) ----------
app.get('/login', (req, res) => res.send(loginHtml()));
app.get('/inbox', requireLogin, (req, res) => res.send(inboxHtml(req.session.user)));

app.get('/api/conversations', requireLogin, (req, res) => {
  const cid = req.session.user.client_id;
  const msgs = _db.messages.filter(m => m.client_id === cid);
  const byNum = {};
  for (const m of msgs) (byNum[m.from_num] = byNum[m.from_num] || []).push(m);
  const convs = Object.entries(byNum).map(([num, list]) => ({
    num,
    last: list[list.length - 1],
    count: list.length,
    unread: list.filter(m => m.direction === 'in' && !m.read).length
  })).sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
  res.json({ client: _db.clients.find(c => c.id === cid), conversations: convs });
});
app.get('/api/messages/:num', requireLogin, (req, res) => {
  const cid = req.session.user.client_id;
  const list = _db.messages.filter(m => m.client_id === cid && m.from_num === req.params.num);
  list.forEach(m => { if (m.direction === 'in') m.read = true; }); save(_db);
  res.json(list);
});
app.post('/api/reply', requireLogin, async (req, res) => {
  const cid = req.session.user.client_id;
  const client = _db.clients.find(c => c.id === cid);
  if (!client) return res.status(404).send('no client');
  const { num, text } = req.body;
  await sendText(client, num, text);
  res.json({ ok: true });
});

// ---------- admin (owner) ----------
app.get('/admin', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const expected = 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64');
  if (auth !== expected) { res.set('WWW-Authenticate', 'Basic realm="RX WA"'); return res.status(401).send('🔒 مصرح فقط'); }
  res.send(adminHtml());
});
app.post('/admin/user', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const expected = 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64');
  if (auth !== expected) return res.status(401).send('🔒');
  const { username, password, client_id, email } = req.body;
  if (!username || !password || !client_id) return res.status(400).send('missing');
  if (_db.users.find(u => u.username === username)) return res.status(400).send('موجود');
  _db.users.push({ username, client_id, password: bcrypt.hashSync(password, 10), role: 'staff', email: email || '' });
  save(_db);
  res.redirect('/admin');
});
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/admin/api/qa', (req, res) => {
  const dist = {};
  for (const r of _db.qa) dist[r.client_id] = (dist[r.client_id] || 0) + 1;
  res.json({ count: _db.qa.length, clientIds: dist });
});

// ---------- HTML ----------
function loginHtml() {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>RX WA — دخول</title>
  <style>body{font-family:Tahoma,sans-serif;background:#FBF7F0;display:flex;height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;padding:30px;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:320px}
  input{padding:10px;width:100%;margin:8px 0;border:1px solid #ECE3D5;border-radius:8px;box-sizing:border-box}
  button{background:#25D366;color:#fff;border:0;padding:11px;width:100%;border-radius:8px;font-weight:700;cursor:pointer}</style></head>
  <body><div class="card"><h2>RX WA 💬</h2>
  <form method="POST" action="/login"><input name="username" placeholder="اسم المستخدم" required>
  <input name="password" type="password" placeholder="كلمة السر" required>
  <button>دخول</button></form></div></body></html>`;
}
function inboxHtml(user) {
  const client = _db.clients.find(c => c.id === user.client_id);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Inbox — ${client ? client.name : ''}</title>
  <style>body{font-family:Tahoma,sans-serif;background:#FBF7F0;margin:0}
  header{background:#075E54;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
  .wrap{display:flex;height:calc(100vh - 54px)}
  .list{width:300px;background:#fff;border-left:1px solid #eee;overflow:auto}
  .conv{padding:12px;border-bottom:1px solid #f0f0f0;cursor:pointer}
  .conv:hover{background:#f5f5f5}.conv b{color:#111}.conv .un{background:#25D366;color:#fff;border-radius:10px;padding:1px 7px;font-size:12px}
  .chat{flex:1;display:flex;flex-direction:column}
  .msgs{flex:1;padding:16px;overflow:auto}
  .b{margin:6px 0;max-width:70%;padding:9px 13px;border-radius:12px;clear:both}
  .in{background:#fff;border:1px solid #eee;float:right}.out{background:#DCF8C6;float:left}
  .box{padding:12px;border-top:1px solid #eee;display:flex;gap:8px}
  .box input{flex:1;padding:10px;border:1px solid #ECE3D5;border-radius:8px}
  .box button{background:#25D366;color:#fff;border:0;padding:10px 18px;border-radius:8px;cursor:pointer}</style></head>
  <body><header><div>💬 RX WA — ${client ? client.name : ''}</div><a href="/logout" style="color:#fff">خروج</a></header>
  <div class="wrap"><div class="list" id="list"></div>
  <div class="chat"><div class="msgs" id="msgs"></div>
  <div class="box"><input id="txt" placeholder="اكتب رداً..."><button onclick="send()">إرسال</button></div></div></div>
  <script>
  let cur='';
  async function load(){const r=await fetch('/api/conversations');const d=await r.json();
    document.getElementById('list').innerHTML=d.conversations.map(c=>'<div class="conv" onclick="open(\\''+c.num+'\\')"><b>'+c.num+'</b><div>'+c.last.text.slice(0,30)+'</div>'+(c.unread?'<span class="un">'+c.unread+'</span>':'')+'</div>').join('');}
  async function open(num){cur=num;const r=await fetch('/api/messages/'+num);const d=await r.json();
    document.getElementById('msgs').innerHTML=d.map(m=>'<div class="b '+m.direction+'">'+m.text+'</div>').join('');
    load();}
  async function send(){if(!cur)return;const t=document.getElementById('txt').value;if(!t)return;
    await fetch('/api/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({num:cur,text:t})});
    document.getElementById('txt').value='';open(cur);}
  load();setInterval(load,5000);
  </script></body></html>`;
}
function adminHtml() {
  const users = _db.users.map(u => `<tr><td>${u.username}</td><td>${u.client_id}</td><td>${u.role}</td></tr>`).join('') || '<tr><td colspan="3">لا يوجد</td></tr>';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>RX WA — إدارة</title>
  <style>body{font-family:Tahoma;background:#FBF7F0;padding:24px;max-width:700px;margin:auto}
  input,select{padding:9px;margin:5px 0;width:100%;box-sizing:border-box;border:1px solid #ECE3D5;border-radius:8px}
  .card{background:#fff;border:1px solid #ECE3D5;border-radius:14px;padding:20px;margin-bottom:18px}
  button{background:#25D366;color:#fff;border:0;padding:10px 20px;border-radius:8px;cursor:pointer}table{width:100%;border-collapse:collapse}td,th{border:1px solid #eee;padding:6px}</style></head>
  <body><h1>RX WA — إدارة</h1>
  <div class="card"><h3>إضافة مستخدم (عميل/موظف)</h3><form method="POST" action="/admin/user">
  <input name="username" placeholder="اسم المستخدم" required><input name="password" placeholder="كلمة السر" required>
  <input name="client_id" placeholder="معرف العميل (halat)" value="halat"><input name="email" placeholder="إيميل التنبيه">
  <button>إضافة</button></form></div>
  <div class="card"><h3>المستخدمون</h3><table><tr><th>مستخدم</th><th>عميل</th><th>دور</th></tr>${users}</table></div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RX WA v2.0 شغّالة على ${PORT}`));
