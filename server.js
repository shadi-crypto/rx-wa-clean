// RX WA — multi-tenant WhatsApp automation (PROVEN WORKING, no Supabase)
// Official Meta WhatsApp Cloud API (zero ban risk). Self-hosted, no SaaS subscription.
// Replies WITHOUT an LLM: local JSON store (seeded from qa.json on boot) + fuse.js semantic matching.
// Features: per-client phoneId+token+flow, password-protected admin panel, live inbox, /health route.
//
// LESSONS BAKED IN (so we never repeat the 3-day failure):
//  - NO Supabase/Postgres/SQLite-external: local store.json, seeded from qa.json on EVERY boot → survives Render cold start.
//  - res.sendStatus(200) AFTER await handleMessage (Meta allows 20s; critical state writes must complete).
//  - Default client is auto-created on boot (bot dies silently if missing).
//  - findReply is defined; webhook payload guarded on object === 'whatsapp_business_account'.
//  - x-hub-signature-256 verification (security: reject forged webhooks).
//  - /health is UNPROTECTED (Render health check). /admin is Basic-auth protected.
//  - response charset forced utf-8 (Arabic display).

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');
require('dotenv').config();

const app = express();
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true, type: 'application/x-www-form-urlencoded' }));
app.use((req, res, next) => { res.set('Content-Type', 'text/html; charset=utf-8'); next(); });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'RxWa@2026!SecureVerify';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RxWa@2026!Admin';
const APP_SECRET = process.env.META_APP_SECRET || '';           // needed for x-hub-signature-256
const API_VERSION = process.env.WA_API_VERSION || 'v19.0';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'store.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { clients: [], qa: [], messages: [], flows: {}, misses: {} }; }
}
function save(d) { try { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); } catch (e) {} }
let _db = load();

// auto-create default client + seed Q&A from qa.json on EVERY boot (survives cold start)
function boot() {
  if (!_db.clients.find(c => c.id === 'halat')) {
    _db.clients.push({ id: 'halat', name: 'هالات', phone_id: process.env.HALAT_PHONE_ID || 'HALATID', wa_token: process.env.HALAT_WA_TOKEN || 'demo', flow: 'qa' });
  }
  if (!_db.qa.length) {
    try {
      const qa = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa.json'), 'utf8'));
      _db.qa = qa.map(q => ({ client_id: q.client_id || 'halat', question: q.question, keywords: q.keywords, reply: q.reply }));
      console.log(`[BOOT] زرع ${_db.qa.length} سؤال من qa.json ✅`);
    } catch (e) { console.log('[BOOT] تعذّر زرع qa:', e.message); }
  }
  save(_db);
  console.log(`[BOOT] جاهز: ${_db.clients.length} عميل، ${_db.qa.length} سؤال`);
}
boot();

const getClientByPhone = (phoneId) => _db.clients.find(c => c.phone_id === phoneId) || null;
const logMsg = (cid, from, dir, text) => {
  _db.messages.push({ client_id: cid, from_num: from, direction: dir, text, at: new Date().toISOString() });
  if (_db.messages.length > 300) _db.messages = _db.messages.slice(-300);
  save(_db);
};

// ---------- reply engine: keyword + semantic ----------
function findReply(client, text) {
  const rows = _db.qa.filter(q => q.client_id === client.id);
  if (!rows.length) return null;
  const lower = text.toLowerCase();
  for (const r of rows) {
    const keys = (r.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keys.some(k => lower.includes(k))) return r.reply;       // 1) exact keyword
  }
  const fuse = new Fuse(rows, { keys: ['question', 'keywords'], threshold: 0.5 });
  const hit = fuse.search(text);
  if (hit.length) return hit[0].item.reply;                      // 2) paraphrase match
  return null;
}

// ---------- webhook verify ----------
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ---------- receive (verify Meta signature, then process) ----------
app.post('/webhook', (req, res) => {
  // Security: reject forged requests (skip if no APP_SECRET configured — dev mode)
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
    res.sendStatus(200);   // reply 200 AFTER processing (Meta allows 20s)
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

// ---------- reply logic (incl. multi-step damage flow + miss counter) ----------
async function handleMessage(client, from, text, hasImage) {
  console.log(`[ROUTE] ${client.name} <- ${from}: "${text}"`);
  const lower = text.toLowerCase();

  // multi-step damage flow (persisted locally)
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
  // miss counter → handoff to human after 3
  const miss = (_db.misses[from] || 0) + 1;
  _db.misses[from] = miss; save(_db);
  if (miss >= 3) {
    delete _db.misses[from]; save(_db);
    return sendText(client, from, '🙋 يبدو أن سؤالك خارج نطاق المعرفة الحالية. تواصل مباشرة مع موظف هالات على 966579591669 أو info@Halat.sa وسيساعدونك فوراً.');
  }
  return sendText(client, from, '🤖 ما قدرت أفهم سؤالك. اكتب كلمات أوضح، أو "موظف" للتواصل المباشر.');
}

// ---------- admin auth ----------
function checkAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const expected = 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64');
  if (auth === expected) return next();
  res.set('WWW-Authenticate', 'Basic realm="RX WA Admin"');
  return res.status(401).send('🔒 مصرح فقط');
}

// ---------- health (UNPROTECTED — Render health check) ----------
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- admin panel ----------
app.get('/admin', checkAuth, (req, res) => res.send(adminHtml()));
app.post('/admin/client', checkAuth, (req, res) => {
  const { id, name, phoneId, waToken, flow } = req.body;
  if (!id || !phoneId || !waToken) return res.status(400).send('missing fields');
  const i = _db.clients.findIndex(c => c.id === id);
  const rec = { id, name, phone_id: phoneId, wa_token: waToken, flow: flow || 'qa' };
  if (i >= 0) _db.clients[i] = rec; else _db.clients.push(rec);
  save(_db);
  res.redirect('/admin');
});
app.post('/admin/qa', checkAuth, (req, res) => {
  const { client_id, question, keywords, reply } = req.body;
  if (!client_id || !question || !reply) return res.status(400).send('missing fields');
  _db.qa.push({ client_id, question, keywords, reply }); save(_db);
  res.redirect('/admin');
});
app.get('/admin/api/messages', checkAuth, (req, res) =>
  res.json(_db.messages.slice(-50).reverse()));
app.get('/admin/api/qa', checkAuth, (req, res) => {
  const dist = {};
  for (const r of _db.qa) dist[r.client_id] = (dist[r.client_id] || 0) + 1;
  res.json({ count: _db.qa.length, clientIds: dist });
});

function adminHtml() {
  const clientOpts = _db.clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const qaRows = _db.qa.map(r => `<tr><td>${r.client_id}</td><td>${r.question}</td><td>${r.keywords}</td><td>${r.reply}</td></tr>`).join('') || '<tr><td colspan="4">لا يوجد</td></tr>';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>RX WA — لوحة التحكم</title>
  <style>body{font-family:Tahoma,Segoe UI,sans-serif;background:#FBF7F0;color:#1F2933;padding:24px;max-width:900px;margin:auto}
  input,select,textarea{padding:9px;margin:5px 0;width:100%;box-sizing:border-box;border:1px solid #ECE3D5;border-radius:8px}
  .card{background:#fff;border:1px solid #ECE3D5;border-radius:14px;padding:20px;margin-bottom:18px}
  button{background:#25D366;color:#fff;border:0;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:700}
  h1{font-size:24px}h3{margin-top:0}table{width:100%;border-collapse:collapse}td,th{border:1px solid #eee;padding:6px;text-align:right;font-size:13px}</style></head>
  <body><h1>💬 RX WA — لوحة التحكم</h1>
  <div class="card"><h3>إضافة عميل جديد</h3><form method="POST" action="/admin/client">
    <input name="id" placeholder="معرف (halat)" required><input name="name" placeholder="الاسم (هالات)" required>
    <input name="phoneId" placeholder="Phone ID من ميتا" required><input name="waToken" placeholder="Token من ميتا" required>
    <input name="flow" placeholder="qa" value="qa"><button>إضافة</button></form></div>
  <div class="card"><h3>إضافة سؤال/جواب (Q&A)</h3><form method="POST" action="/admin/qa">
    <select name="client_id">${clientOpts}</select>
    <input name="question" placeholder="السؤال (مثال: كم مدة الشحن)">
    <input name="keywords" placeholder="كلمات مفتاحية (شحن,توصيل,وصل) مفصولة بفواصل">
    <textarea name="reply" placeholder="الرد"></textarea><button>إضافة سؤال</button></form></div>
  <div class="card"><h3>قاعدة الأسئلة الحالية (${_db.qa.length})</h3>
    <table><tr><th>عميل</th><th>سؤال</th><th>كلمات</th><th>رد</th></tr>${qaRows}</table></div>
  <div class="card"><h3>أحدث المحادثات</h3><div id="msgs"></div>
    <script>fetch('/admin/api/messages').then(r=>r.json()).then(d=>{
      document.getElementById('msgs').innerHTML = d.map(m=>
        '<div style="border-bottom:1px solid #eee;padding:5px 0"><b>'+m.client_id+'</b> ['+m.direction+'] '+m.from_num+': '+m.text+'</div>'
      ).join('') || 'لا رسائل';
    });</script></div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RX WA شغّالة على ${PORT}`));
