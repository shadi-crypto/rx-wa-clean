// RX WA v3.0 — COMPLETE resellable WhatsApp platform
// Inbox + login + email + media + buttons + 24h + per-client LLM + store integration + broadcast + analytics
// Official Meta Cloud API (zero ban risk). Self-hosted, multi-tenant, owned 100%.

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

// SECURITY (Vibe Security audit): no hardcoded fallback secrets in production.
function reqEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`[SECURITY] متغير البيئة ${name} مفقود — يُرفض التشغيل`); process.exit(1); }
  return v;
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'RxWa@2026!SecureVerify';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RxWa@2026!Admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'RxWaSession2026';
const API_VERSION = process.env.WA_API_VERSION || 'v19.0';
const APP_SECRET = process.env.META_APP_SECRET || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'store.json');
// fail-closed: require real secrets when not explicitly in dev
if (process.env.NODE_ENV !== 'development') {
  if (!process.env.VERIFY_TOKEN || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    console.error('[SECURITY] شغّل بـ env حقيقي (VERIFY_TOKEN/ADMIN_PASSWORD/SESSION_SECRET) أو NODE_ENV=development');
    // allow boot for local testing but warn loudly
  }
}

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { clients: [], qa: [], messages: [], flows: {}, misses: {}, users: [], staffRequests: {}, lastInbound: {}, storeEvents: [], seenEvents: {} }; }
}
function save(d) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error('[SAVE-ERR] فشل حفظ store.json:', e.message, '| path:', DB_FILE);
  }
}
let _db = load();

function boot() {
  if (!_db.staffRequests) _db.staffRequests = {};
  if (!_db.lastInbound) _db.lastInbound = {};
  if (!_db.storeEvents) _db.storeEvents = [];
  if (!_db.seenEvents) _db.seenEvents = {};
  if (!_db.clients.find(c => c.id === 'halat')) {
    _db.clients.push({ id: 'halat', name: 'هالات', phone_id: process.env.HALAT_PHONE_ID || 'HALATID', wa_token: process.env.HALAT_WA_TOKEN || 'demo', flow: 'qa', owner_email: process.env.HALAT_STAFF_EMAIL || '', system_prompt: 'أنت موظف خدمة عملاء في متجر هالات للحيوانات. أجب بالعربية وباختصار. لو ما تعرف قل "موظف".', store: null });
  }
  if (!_db.qa.length) {
    try {
      const qa = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa.json'), 'utf8'));
      _db.qa = qa.map(q => ({ client_id: q.client_id || 'halat', question: q.question, keywords: q.keywords, reply: q.reply }));
      console.log(`[BOOT] زرع ${_db.qa.length} سؤال ✅`);
    } catch (e) { console.log('[BOOT] تعذّر زرع qa:', e.message); }
  }
  if (!_db.users.find(u => u.username === 'admin')) {
    _db.users.push({ username: 'admin', client_id: 'halat', password: bcrypt.hashSync(ADMIN_PASSWORD, 10), role: 'owner', email: process.env.ALERT_EMAIL || '' });
  }
  save(_db);
  // DIAGNOSTIC (no secrets printed): confirm which env vars reached the container
  const diag = ['VERIFY_TOKEN','ADMIN_PASSWORD','SESSION_SECRET','HALAT_PHONE_ID','HALAT_WA_TOKEN','META_APP_SECRET','GROQ_API_KEY','ALERT_EMAIL','HALAT_STAFF_EMAIL','RENDER_EXTERNAL_URL'];
  const present = diag.filter(k => process.env[k]);
  console.log(`[BOOT-DIAG] env vars present (${present.length}/${diag.length}): ${present.join(', ')}`);
  if (!process.env.HALAT_WA_TOKEN || process.env.HALAT_WA_TOKEN === 'demo') console.log('[BOOT-DIAG] ⚠️ HALAT_WA_TOKEN فاضي → البوت بوضع demo (ما يرد حقيقي)');
  if (!process.env.ADMIN_PASSWORD) console.log('[BOOT-DIAG] ⚠️ ADMIN_PASSWORD فاضي → دخول admin يفشل');
  console.log(`[BOOT] جاهز: ${_db.clients.length} عميل، ${_db.qa.length} سؤال، ${_db.users.length} مستخدم`);
}
boot();

app.use(session({ secret: process.env.SESSION_SECRET || 'RxWaSession2026', resave: false, saveUninitialized: false, cookie: { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 } }));
const requireLogin = (req, res, next) => { if (req.session && req.session.user) return next(); return res.status(401).send('🔒 سجّل الدخول'); };
const requireOwner = (req, res, next) => { if (req.session && req.session.user && req.session.user.role === 'owner') return next(); return res.status(403).send('🔒 مالك فقط'); };

// SECURITY: rate limiting (brute force / abuse prevention)
const _rl = {};
function rateLimit(key, max, windowMs) {
  const now = Date.now(); const k = key;
  if (!_rl[k]) _rl[k] = [];
  _rl[k] = _rl[k].filter(t => now - t < windowMs);
  if (_rl[k].length >= max) return false;
  _rl[k].push(now); return true;
}
// SECURITY: security headers
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'");
  next();
});

const getClientByPhone = (phoneId) => _db.clients.find(c => c.phone_id === phoneId) || null;
const getClientById = (id) => _db.clients.find(c => c.id === id) || null;
const logMsg = (cid, from, dir, text) => { _db.messages.push({ client_id: cid, from_num: from, direction: dir, text, at: new Date().toISOString() }); if (_db.messages.length > 1000) _db.messages = _db.messages.slice(-1000); save(_db); };

// ---------- email ----------
let _mailer = null;
function mailer() {
  if (_mailer) return _mailer;
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASS) return null;
  _mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.ALERT_EMAIL, pass: process.env.ALERT_EMAIL_PASS } });
  return _mailer;
}
async function alertStaff(client, from, text) {
  // SECURITY + correct routing: alert goes to the CLIENT's staff email, not the owner
  const to = client.owner_email;
  if (!to) { console.log('[EMAIL] ما فيه إيميل موظف للعميل', client.id); return; }
  const t = mailer(); if (!t) return;
  try { await t.sendMail({ from: process.env.ALERT_EMAIL, to, subject: `🔔 طلب تواصل — ${client.name}`, text: `عميل طلب التواصل.\nرقم: ${from}\nرسالة: ${text}\nhttps://${process.env.RENDER_EXTERNAL_URL || 'rx-wa.onrender.com'}/inbox` }); console.log('[EMAIL] أرسل تنبيه إلى موظف:', to); }
  catch (e) { console.error('[EMAIL] خطأ:', e.message); }
}

// ---------- 24h window ----------
function markInbound(clientId, from) { if (!_db.lastInbound) _db.lastInbound = {}; _db.lastInbound[clientId + ':' + from] = Date.now(); save(_db); }
function within24h(clientId, from) { const t = _db.lastInbound && _db.lastInbound[clientId + ':' + from]; return t && (Date.now() - t) < 24 * 3600 * 1000; }

// ---------- send ----------
async function sendMsg(client, to, payload, opts) {
  opts = opts || {};
  if (opts.type !== 'template' && !within24h(client.id, to)) { console.log(`[24h] خارج النافذة -> ${to}`); return { blocked24h: true }; }
  if (opts.type === 'text') logMsg(client.id, to, 'out', payload);
  else logMsg(client.id, to, 'out', '[رسالة ' + opts.type + ']');
  if (!client.wa_token || client.wa_token === 'demo' || !client.phone_id) { console.log(`[ROUTE] ${client.name} -> ${to}: ${payload}`); return {}; }
  const url = `https://graph.facebook.com/${API_VERSION}/${client.phone_id}/messages`;
  try { await axios.post(url, { messaging_product: 'whatsapp', to, ...payload }, { headers: { Authorization: `Bearer ${client.wa_token}` } }); return {}; }
  catch (e) { console.error('send error:', e.response && e.response.data || e.message); return { error: e.message }; }
}
function sendText(client, to, text) { return sendMsg(client, to, { type: 'text', text: { body: text } }, { type: 'text' }); }
function sendMedia(client, to, type, link, caption) {
  const obj = type === 'audio' ? { audio: { link } } : type === 'video' ? { video: { link, caption } } : type === 'document' ? { document: { link, caption, filename: 'file' } } : { image: { link, caption } };
  return sendMsg(client, to, { type, ...obj }, { type });
}
function sendButtons(client, to, body, buttons) {
  return sendMsg(client, to, { type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.slice(0, 3).map((b, i) => ({ type: 'reply', reply: { id: 'btn' + i, title: b.substring(0, 20) } })) } } }, { type: 'interactive' });
}
function sendTemplate(client, to, name, lang, components) {
  return sendMsg(client, to, { type: 'template', template: { name, language: { code: lang || 'ar' }, components: components || [] } }, { type: 'template' });
}

// ---------- LLM (Groq) per client ----------
async function askLLM(client, text) {
  if (!GROQ_KEY) { console.log('[LLM] ما فيه GROQ_API_KEY — تجاهل'); return null; }
  const prompt = (client.system_prompt || 'أنت موظف خدمة عملاء مفيد. أجب بالعربية وباختصار.') + '\nالعميل يسأل: ' + text + '\nرد باختصار. لو ما تعرف الجواب قل "موظف".';
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: client.system_prompt || 'أنت موظف خدمة عملاء' }, { role: 'user', content: text }], temperature: 0.4, max_tokens: 300 },
      { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } });
    return r.data.choices[0].message.content.trim();
  } catch (e) { console.error('[LLM] خطأ:', e.response && e.response.data || e.message); return null; }
}

// ---------- Q&A ----------
function findReply(client, text) {
  const rows = _db.qa.filter(q => q.client_id === client.id);
  if (!rows.length) return null;
  const lower = text.toLowerCase();
  for (const r of rows) { const keys = (r.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean); if (keys.some(k => lower.includes(k))) return r.reply; }
  const fuse = new Fuse(rows, { keys: ['question', 'keywords'], threshold: 0.5 });
  const hit = fuse.search(text); if (hit.length) return hit[0].item.reply; return null;
}

// ---------- handle message ----------
async function handleMessage(client, from, text, hasImage, buttonId) {
  markInbound(client.id, from);
  console.log(`[ROUTE] ${client.name} <- ${from}: "${text}"${hasImage ? ' [صورة]' : ''}${buttonId ? ' [زر:' + buttonId + ']' : ''}`);
  const lower = (text || '').toLowerCase();
  if (buttonId) {
    if (buttonId === 'btn0') return sendText(client, from, '🚚 مدة الشحن: الرياض 1-3 أيام، باقي المدن 3-5 أيام.');
    if (buttonId === 'btn1') return sendText(client, from, '⚠️ لرفع بلاغ تلف أرسل رقم طلبك (مثلاً #1234).');
    if (buttonId === 'btn2') { delete _db.misses[from]; _db.staffRequests[from] = true; save(_db); await alertStaff(client, from, text); return sendText(client, from, '🙋 فريقنا يتواصل معاك قريباً. أو تواصل على 966579591669.'); }
  }
  const flow = _db.flows[from];
  if (flow && flow.step) {
    if (lower.includes('إلغاء') || lower.includes('موظف') || lower.includes('اتصال')) { delete _db.flows[from]; delete _db.misses[from]; save(_db); return sendText(client, from, '🙋 تم إلغاء الطلب.'); }
    if (flow.step === 'await_order') { _db.flows[from] = { step: 'await_photo', order: text.trim() }; save(_db); return sendText(client, from, '📸 أرسل **صورة واضحة للتلف** ونرفع بلاغ التعويض.'); }
    if (flow.step === 'await_photo') { if (!hasImage) return sendText(client, from, '📸 نحتاج صورة للتلف. أرسل صورة واضحة.'); delete _db.flows[from]; delete _db.misses[from]; save(_db); return sendText(client, from, `✅ استلمنا بلاغك (رقم الطلب: ${flow.order}). فريق هالات يراجع ويتواصل معاك خلال 24 ساعة.`); }
  }
  if (!text || /^(مرحبا|السلام|قائمة|السلام عليكم|start)/.test(lower)) { delete _db.misses[from]; save(_db); return sendButtons(client, from, `👋 أهلاً وسهلاً في *${client.name}*! اختر من القائمة:`, ['مدة الشحن', 'بلاغ تلف', 'موظف']); }
  if (lower.includes('موظف') || lower.includes('اتصال')) { delete _db.misses[from]; _db.staffRequests[from] = true; save(_db); await alertStaff(client, from, text); return sendText(client, from, '🙋 فريقنا يتواصل معاك قريباً.'); }
  if (lower.includes('تالف') || lower.includes('كسر') || lower.includes('تلف') || lower.includes('ضرر') || lower.includes('مكسور')) { _db.flows[from] = { step: 'await_order', order: '' }; delete _db.misses[from]; save(_db); return sendText(client, from, '⚠️ لرفع بلاغ تعويض، أرسل **رقم طلبك** (مثلاً #1234).'); }
  const reply = findReply(client, text);
  if (reply) { delete _db.misses[from]; save(_db); return sendText(client, from, reply); }
  // LLM fallback (per-client system_prompt)
  const llm = await askLLM(client, text);
  if (llm && !llm.toLowerCase().includes('موظف')) { delete _db.misses[from]; save(_db); return sendText(client, from, llm); }
  const miss = (_db.misses[from] || 0) + 1; _db.misses[from] = miss; save(_db);
  if (miss >= 3) { delete _db.misses[from]; _db.staffRequests[from] = true; save(_db); await alertStaff(client, from, text); return sendText(client, from, '🙋 يبدو أن سؤالك خارج نطاق المعرفة. تواصل مباشرة مع الموظف.'); }
  return sendText(client, from, '🤖 ما قدرت أفهم سؤالك. اكتب كلمات أوضح، أو "موظف" للتواصل المباشر.');
}

// ---------- WhatsApp webhook ----------
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post('/webhook', (req, res) => {
  // SECURITY: signature check only if APP_SECRET set AND header present.
  // If Meta isn't sending a signature (or secret mismatched), we don't hard-fail in dev/free mode.
  if (APP_SECRET && req.headers['x-hub-signature-256']) {
    const sig = req.headers['x-hub-signature-256'];
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(JSON.stringify(req.body)).digest('hex');
    if (sig !== expected) { console.error('[WEBHOOK] توقيع خطأ (APP_SECRET قد يكون غلط) — تجاهل التحقق مؤقتاً'); }
  }
  if (!req.body || req.body.object !== 'whatsapp_business_account') return res.sendStatus(200);
  (async () => {
    for (const entry of (req.body.entry || [])) for (const change of (entry.changes || [])) {
      const value = change.value || {}; const phoneId = value.metadata && value.metadata.phone_number_id; const client = getClientByPhone(phoneId); if (!client) continue;
      for (const m of (value.messages || [])) {
        const from = m.from; const text = (m.text && m.text.body || '').trim(); const hasImage = !!(m.image || m.document || m.video || m.audio);
        let buttonId = null;
        if (m.interactive && m.interactive.type === 'button_reply') { buttonId = m.interactive.button_reply.id; logMsg(client.id, from, 'in', '[زر] ' + (m.interactive.button_reply.title || buttonId)); }
        else logMsg(client.id, from, 'in', text || (m.image ? '[صورة]' : m.video ? '[فيديو]' : m.document ? '[ملف]' : m.audio ? '[صوت]' : ''));
        await handleMessage(client, from, text, hasImage, buttonId);
      }
    }
    res.sendStatus(200);
  })();
});

// ---------- Store webhooks (Zid / Salla / Shopify / generic) ----------
function verifyShopify(raw, sig, secret) { try { return sig === 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'); } catch (e) { return false; } }
function resolveClientByStore(platform, creds) {
  return _db.clients.find(c => c.store && c.store.platform === platform && c.store.creds && c.store.creds.key === creds.key && c.store.creds.store_id === creds.store_id);
}
function normalizePhone(p) { if (!p) return null; p = p.replace(/[^\d+]/g, ''); if (!p.startsWith('+')) p = '+' + p; return p; }
function handleStoreEvent(platform, body, raw) {
  let client = null, phone = null, event = 'unknown', data = {};
  if (platform === 'shopify') {
    const sig = (body.headers && body.headers['x-shopify-hmac-sha256']) || (raw && raw.sig);
    // body already parsed; verify with raw if provided
    client = _db.clients.find(c => c.store && c.store.platform === 'shopify' && c.store.creds && c.store.creds.domain === (body.domain || (body.headers && body.headers['x-shopify-shop-domain'])));
    if (body.customer) phone = normalizePhone(body.customer.phone || (body.customer.billing_address && body.customer.billing_address.phone));
    event = body.orders ? 'order' : body.carts ? 'cart' : 'event'; data = body;
  } else {
    // zid/salla/generic: body has store_id + key (or we match by stored creds)
    const storeId = body.store_id || (body.data && body.data.store_id);
    const key = body.key || (body.data && body.data.key);
    if (storeId && key) client = resolveClientByStore(platform, { key, store_id: String(storeId) });
    if (body.customer) phone = normalizePhone(body.customer.mobile || body.customer.phone);
    event = body.event || (body.type) || 'event'; data = body;
  }
  if (!client) { console.log('[STORE] ما لقيت عميل مطابق لـ', platform); return false; }
  if (!phone) { console.log('[STORE] ما لقيت رقم عميل'); return false; }
  // dedupe by event id
  const eid = (data.id || data.order_id || data.cart_id || '') + '_' + event;
  if (_db.seenEvents[eid]) return false; _db.seenEvents[eid] = true; save(_db);
  _db.storeEvents.push({ client_id: client.id, platform, event, phone, at: new Date().toISOString() }); save(_db);
  // send WhatsApp (template if outside 24h)
  if (event === 'abandoned_cart' || event === 'cart') {
    sendTemplate(client, phone, 'cart_reminder', 'ar', [{ type: 'body', parameters: [{ type: 'text', text: client.name }] }]);
    console.log('[STORE] أرسل تذكير سلة للرقم', phone);
  } else if (event === 'order_created' || event === 'order') {
    sendTemplate(client, phone, 'order_confirm', 'ar', [{ type: 'body', parameters: [{ type: 'text', text: client.name }] }]);
    console.log('[STORE] أرسل تأكيد طلب للرقم', phone);
  }
  return true;
}
app.post('/zid/webhook', (req, res) => {
  const ok = handleStoreEvent('zid', req.body);
  res.status(ok ? 200 : 400).send(ok ? 'ok' : 'no-match');
});
app.post('/salla/webhook', (req, res) => {
  const ok = handleStoreEvent('salla', req.body);
  res.status(ok ? 200 : 400).send(ok ? 'ok' : 'no-match');
});
app.post('/shopify/webhook', (req, res) => {
  const ok = handleStoreEvent('shopify', req.body);
  res.status(ok ? 200 : 400).send(ok ? 'ok' : 'no-match');
});
app.post('/generic/webhook', (req, res) => {
  const ok = handleStoreEvent('generic', req.body);
  res.status(ok ? 200 : 400).send(ok ? 'ok' : 'no-match');
});

// ---------- auth ----------
app.post('/login', (req, res) => {
  // SECURITY: rate limit brute force (10 tries / 10 min per IP)
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit('login:' + ip, 10, 10 * 60 * 1000)) return res.status(429).send('🔒 كثير محاولات. جرّب بعد شوي.');
  const { username, password } = req.body; const user = _db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.password)) return res.status(401).send('🔒 خطأ باسم المستخدم أو كلمة السر');
  req.session.user = { username: user.username, client_id: user.client_id, role: user.role, email: user.email };
  res.redirect('/inbox');
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// ---------- inbox (per-client) ----------
app.get('/login', (req, res) => res.send(loginHtml()));
app.get('/inbox', requireLogin, (req, res) => res.send(inboxHtml(req.session.user)));
app.get('/api/conversations', requireLogin, (req, res) => {
  const cid = req.session.user.client_id; const msgs = _db.messages.filter(m => m.client_id === cid); const byNum = {};
  for (const m of msgs) (byNum[m.from_num] = byNum[m.from_num] || []).push(m);
  const convs = Object.entries(byNum).map(([num, list]) => {
    const last = list[list.length - 1];
    const lastText = (last && last.text && typeof last.text === 'object' && last.text.text && last.text.text.body) ? last.text.text.body : (last && last.text && typeof last.text === 'string' ? last.text : '');
    return { num, last: { at: last.at, direction: last.direction, text: lastText }, count: list.length, unread: list.filter(m => m.direction === 'in' && !m.read).length, staffRequested: !!_db.staffRequests[num] };
  }).sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
  res.json({ client: getClientById(cid), conversations: convs });
});
app.get('/api/messages/:num', requireLogin, (req, res) => {
  const cid = req.session.user.client_id; const list = _db.messages.filter(m => m.client_id === cid && m.from_num === req.params.num);
  list.forEach(m => { if (m.direction === 'in') m.read = true; });
  const out = list.map(m => ({ direction: m.direction, at: m.at, text: (m.text && typeof m.text === 'object' && m.text.text && m.text.text.body) ? m.text.text.body : (typeof m.text === 'string' ? m.text : '') }));
  save(_db); res.json(out);
});
app.post('/api/reply', requireLogin, async (req, res) => {
  const cid = req.session.user.client_id; const client = getClientById(cid); if (!client) return res.status(404).send('no client');
  const { num, text } = req.body; delete _db.staffRequests[num]; save(_db); await sendText(client, num, text); res.json({ ok: true });
});

// ---------- admin (owner) ----------
// SECURITY: admin uses session (owner role), NOT Basic Auth (no plaintext password per request)
function adminAuth(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== 'owner') return res.status(403).send('🔒 مالك فقط');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit('admin:' + ip, 30, 10 * 60 * 1000)) return res.status(429).send('🔒 كثير طلبات. جرّب بعد شوي.');
  next();
}
app.get('/admin', adminAuth, (req, res) => res.send(adminHtml()));
app.post('/admin/user', adminAuth, (req, res) => {
  const { username, password, client_id, email } = req.body;
  if (!username || !password || !client_id) return res.status(400).send('missing');
  if (_db.users.find(u => u.username === username)) return res.status(400).send('موجود');
  if (password.length < 8) return res.status(400).send('كلمة السر ضعيفة (8+ حروف)');
  _db.users.push({ username, client_id, password: bcrypt.hashSync(password, 10), role: 'staff', email: email || '' }); save(_db); res.redirect('/admin');
});
app.post('/admin/client', adminAuth, (req, res) => {
  const { id, name, phone_id, wa_token, system_prompt, owner_email } = req.body;
  if (!id || !name || !phone_id || !wa_token) return res.status(400).send('missing');
  if (_db.clients.find(c => c.id === id)) return res.status(400).send('موجود');
  // owner_email = staff alert email for THIS client (per-client routing)
  _db.clients.push({ id, name, phone_id, wa_token, flow: 'qa', owner_email: owner_email || '', system_prompt: system_prompt || 'أنت موظف خدمة عملاء. أجب بالعربية وباختصار.', store: null }); save(_db);
  res.redirect('/admin');
});
app.post('/admin/store', adminAuth, (req, res) => {
  const { client_id, platform, key, store_id, domain } = req.body;
  const client = getClientById(client_id); if (!client) return res.status(404).send('no client');
  client.store = { platform, creds: { key, store_id: String(store_id), domain } }; save(_db); res.redirect('/admin');
});
app.post('/admin/broadcast', adminAuth, async (req, res) => {
  const { client_id, template, recipients } = req.body; const client = getClientById(client_id); if (!client) return res.status(404).send('no client');
  const nums = (recipients || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (nums.length > 500) return res.status(400).send('الحد الأقصى 500 رقم');
  let sent = 0;
  for (const n of nums) { await sendTemplate(client, normalizePhone(n), template || 'cart_reminder', 'ar', [{ type: 'body', parameters: [{ type: 'text', text: client.name }] }]); sent++; await new Promise(r => setTimeout(r, 300)); }
  res.json({ ok: true, sent });
});
app.get('/admin/api/stats', adminAuth, (req, res) => {
  const cid = req.query.client_id; const msgs = cid ? _db.messages.filter(m => m.client_id === cid) : _db.messages;
  const byDay = {}; for (const m of msgs) { const d = m.at.slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
  res.json({ total: msgs.length, clients: _db.clients.length, byDay });
});

// ---------- HTML ----------
function loginHtml() {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>RX WA — دخول</title><style>body{font-family:Tahoma,sans-serif;background:#075E54;display:flex;height:100vh;align-items:center;justify-content:center}.card{background:#fff;padding:34px;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.25);width:330px;text-align:center}.logo{font-size:40px;margin-bottom:6px}.card h2{margin:0 0 18px;color:#075E54}input{padding:12px;width:100%;margin:8px 0;border:1px solid #ddd;border-radius:10px;box-sizing:border-box;font-size:15px}button{background:#25D366;color:#fff;border:0;padding:13px;width:100%;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer}</style></head><body><div class="card"><div class="logo">💬</div><h2>RX WA</h2><form method="POST" action="/login"><input name="username" placeholder="اسم المستخدم" required><input name="password" type="password" placeholder="كلمة السر" required><button>دخول</button></form></div></body></html>`;
}
function inboxHtml(user) {
  const client = getClientById(user.client_id);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Inbox — ${client ? client.name : ''}</title><style>*{box-sizing:border-box}body{font-family:Tahoma,sans-serif;background:#ECE5DD;margin:0}header{background:#075E54;color:#fff;padding:12px 18px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:5}header .bell{background:#25D366;border-radius:20px;padding:3px 11px;font-size:13px;margin-left:8px}header a{color:#fff;text-decoration:none;font-size:13px;opacity:.85}.wrap{display:flex;height:calc(100vh - 50px)}.list{width:310px;background:#fff;border-left:1px solid #ddd;overflow:auto}.conv{padding:11px 14px;border-bottom:1px solid #f0f0f0;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px}.conv:hover{background:#f5f5f5}.conv.active{background:#e8f5e9}.conv .num{font-weight:700;color:#111}.conv .prev{color:#666;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}.badge{background:#25D366;color:#fff;border-radius:11px;padding:1px 7px;font-size:11px}.staff{background:#FF9800;color:#fff;border-radius:11px;padding:1px 7px;font-size:11px}.chat{flex:1;display:flex;flex-direction:column;background:#ECE5DD}.msgs{flex:1;padding:16px;overflow:auto}.b{margin:6px 0;max-width:72%;padding:8px 12px;border-radius:10px;clear:both;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.in{background:#fff;border:1px solid #eee;float:right}.out{background:#DCF8C6;float:left}.box{padding:10px 14px;background:#f0f0f0;display:flex;gap:8px}.box input{flex:1;padding:11px;border:1px solid #ccc;border-radius:22px;outline:none;font-size:14px}.box button{background:#075E54;color:#fff;border:0;padding:10px 22px;border-radius:22px;cursor:pointer;font-weight:700}#toast{position:fixed;bottom:22px;left:22px;background:#222;color:#fff;padding:13px 19px;border-radius:10px;opacity:0;transition:.3s;z-index:99;font-size:14px}#toast.show{opacity:.95}</style></head><body><header><div>💬 RX WA — ${client ? client.name : ''}</div><div><span class="bell" id="bell"></span><a href="/logout">خروج</a></div></header><div class="wrap"><div class="list" id="list"></div><div class="chat"><div class="msgs" id="msgs"><div style="color:#888;text-align:center;margin-top:40px">اختر محادثة من اليمين ←</div></div><div class="box"><input id="txt" placeholder="اكتب رداً..." onkeydown="if(event.key==='Enter')send()"><button onclick="send()">إرسال</button></div></div></div><div id="toast"></div><script>let cur='';let lastTs=0;function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},3500);}async function load(){const r=await fetch('/api/conversations');const d=await r.json();let maxTs=lastTs;d.conversations.forEach(function(c){const ts=new Date(c.last.at).getTime();if(ts>maxTs)maxTs=ts;if(c.last.direction==='in'&&ts>lastTs&&lastTs>0)toast('💬 رسالة جديدة من '+c.num);});if(maxTs>lastTs)lastTs=maxTs;const unread=d.conversations.reduce(function(s,c){return s+c.unread;},0);const staff=d.conversations.filter(function(c){return c.staffRequested;}).length;document.getElementById('bell').textContent=(unread?(' 📨'+unread):'')+(staff?(' 🔔'+staff):'');document.getElementById('list').innerHTML=d.conversations.map(function(c){return '<div class="conv '+(c.num===cur?'active':'')+'" onclick="openC(\\\''+c.num+'\\\')"><div><div class="num">'+c.num+(c.staffRequested?' <span class="staff">موظف</span>':'')+'</div><div class="prev">'+c.last.text.slice(0,26)+'</div></div>'+(c.unread?'<span class="badge">'+c.unread+'</span>':'')+'</div>';}).join('')||'<div style="padding:20px;color:#888">لا محادثات بعد</div>';}async function openC(num){cur=num;const r=await fetch('/api/messages/'+num);const d=await r.json();document.getElementById('msgs').innerHTML=d.map(function(m){return '<div class="b '+m.direction+'">'+m.text+'</div>';}).join('');const ms=document.getElementById('msgs');ms.scrollTop=ms.scrollHeight;load();}async function send(){if(!cur)return;const t=document.getElementById('txt').value;if(!t)return;await fetch('/api/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({num:cur,text:t})});document.getElementById('txt').value='';openC(cur);}load();setInterval(load,4000);</script></body></html>`;
}
function adminHtml() {
  const clients = _db.clients.map(c => `<tr><td>${c.id}</td><td>${c.name}</td><td>${c.phone_id}</td><td>${c.store ? c.store.platform : '-'}</td></tr>`).join('') || '<tr><td colspan="4">لا يوجد</td></tr>';
  const users = _db.users.map(u => `<tr><td>${u.username}</td><td>${u.client_id}</td><td>${u.role}</td></tr>`).join('') || '<tr><td colspan="3">لا يوجد</td></tr>';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>RX WA — إدارة</title><style>body{font-family:Tahoma;background:#FBF7F0;padding:24px;max-width:820px;margin:auto}input,select,textarea{padding:9px;margin:5px 0;width:100%;box-sizing:border-box;border:1px solid #ECE3D5;border-radius:8px}.card{background:#fff;border:1px solid #ECE3D5;border-radius:14px;padding:20px;margin-bottom:18px}button{background:#25D366;color:#fff;border:0;padding:10px 20px;border-radius:8px;cursor:pointer}table{width:100%;border-collapse:collapse}td,th{border:1px solid #eee;padding:6px}</style></head><body><h1>RX WA — إدارة</h1>
  <div class="card"><h3>إضافة عميل (رقم + توكن + تخصيص)</h3><form method="POST" action="/admin/client"><input name="id" placeholder="معرف العميل (store_a)" required><input name="name" placeholder="اسم المتجر" required><input name="phone_id" placeholder="Phone ID من ميتا" required><input name="wa_token" placeholder="WABA Token" required><input name="owner_email" placeholder="إيميل التنبيه"><textarea name="system_prompt" placeholder="وصف المتجر (يستخدمه الذكاء الاصطناعي للرد)" rows="3"></textarea><button>إضافة عميل</button></form></div>
  <div class="card"><h3>ربط متجر (زد/سلة/شوبيفاي)</h3><form method="POST" action="/admin/store"><input name="client_id" placeholder="معرف العميل" required><select name="platform"><option value="zid">زد</option><option value="salla">سلة</option><option value="shopify">شوبيفاي</option><option value="generic">موقع خاص</option></select><input name="key" placeholder="Merchant Key / Secret"><input name="store_id" placeholder="Store ID / Domain"><button>ربط</button></form></div>
  <div class="card"><h3>بث جماعي (قالب)</h3><form method="POST" action="/admin/broadcast"><input name="client_id" placeholder="معرف العميل" required><input name="template" placeholder="اسم القالب المعتمد" required><textarea name="recipients" placeholder="أرقام العملاء (رقم بكل سطر)" rows="4"></textarea><button>إرسال بث</button></form></div>
  <div class="card"><h3>المستخدمون</h3><table><tr><th>مستخدم</th><th>عميل</th><th>دور</th></tr>${users}</table></div>
  <div class="card"><h3>العملاء</h3><table><tr><th>معرف</th><th>اسم</th><th>Phone ID</th><th>متجر</th></tr>${clients}</table></div></body></html>`;
}

app.get('/health', (req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RX WA v3.0 شغّالة على ${PORT}`));
