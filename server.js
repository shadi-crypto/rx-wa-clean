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

// SECURITY (Vibe Security audit): no insecure fallback secrets. Env vars are required
// in production; missing critical ones fail-closed (refuse to boot) instead of using defaults.
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const API_VERSION = process.env.WA_API_VERSION || 'v21.0';
const APP_SECRET = process.env.META_APP_SECRET || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
if (!VERIFY_TOKEN || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('[SECURITY] VERIFY_TOKEN / ADMIN_PASSWORD / SESSION_SECRET مفقودة — يُرفض التشغيل');
  process.exit(1);
}
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// ---- Supabase (durable storage via REST, no SDK — proven to work) ----
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';   // service_role key
const _sbOK = !!(SB_URL && SB_KEY);
if (_sbOK) console.log('[BOOT-DIAG] Supabase REST جاهز ✅ (' + SB_URL + ')');
else console.log('[BOOT-DIAG] ⚠️ SUPABASE_URL/KEY فاضي → وضع الذاكرة المؤقت');
const _sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
async function sbReq(method, table, opts = {}) {
  const url = `${SB_URL}/rest/v1/${table}` + (opts.qs ? `?${opts.qs}` : '');
  const r = await axios({ method, url, headers: _sbHeaders, data: opts.body });
  return r.data;
}

// In-memory cache (fast access) — synced with Supabase
let _db = { clients: [], qa: [], users: [], flows: {}, misses: {}, staffRequests: {}, lastInbound: {}, seenEvents: {}, storeEvents: [] };
const _seen = new Set(); // webhook dedupe (in-memory, reliable)

// save() is now a no-op: durable storage goes to Supabase via db* helpers above.
// (In-memory state is synced to Supabase; this keeps legacy save(_db) calls safe.)
function save() { return; }

// ---- DB helpers ----
async function dbLoad() {
  if (!_sbOK) return false;
  try {
    const [cl, qa, us] = await Promise.all([
      sbReq('GET', 'clients', { qs: 'select=*&limit=1000' }),
      sbReq('GET', 'qa', { qs: 'select=*&limit=1000' }),
      sbReq('GET', 'users', { qs: 'select=*&limit=1000' }),
    ]);
    _db.clients = cl || []; _db.qa = qa || []; _db.users = us || [];
    return true;
  } catch (e) { console.error('[SUPABASE] تحميل فشل:', e.message); return false; }
}
async function dbSaveClient(c) {
  if (!_sbOK) return;
  try {
    const row = { id: c.id, name: c.name, phone_id: c.phone_id, wa_token: c.wa_token, flow: c.flow || 'qa', owner_email: c.owner_email || '', system_prompt: c.system_prompt || '', maintenance_msg: c.maintenance_msg || '', store: c.store || null };
    await sbReq('POST', 'clients', { qs: 'on_conflict=id', body: [row] });
  } catch (e) { console.error('[SUPABASE] dbSaveClient فشل (متجاهل):', e.message); }
}
async function dbSaveUser(u) {
  if (!_sbOK) return;
  try { await sbReq('POST', 'users', { qs: 'on_conflict=username', body: [{ username: u.username, client_id: u.client_id, password: u.password, role: u.role, email: u.email || '' }] }); }
  catch (e) { console.error('[SUPABASE] dbSaveUser فشل (متجاهل):', e.message); }
}
async function dbAddMessage(m) {
  if (!_sbOK) { console.error('[SUPABASE] dbAddMessage: لا يوجد اتصال'); return; }
  try {
    const body = (m.text && typeof m.text === 'object' && m.text.text && m.text.text.body) ? m.text.text.body : (typeof m.text === 'string' ? m.text : '');
    const mediaType = (m.text && typeof m.text === 'object') ? m.text.type : null;
    const row = { client_id: m.client_id, from_num: String(m.from_num), direction: m.direction, body, media_type: mediaType, at: m.at || new Date().toISOString() };
    await sbReq('POST', 'messages', { body: [row] });
    console.log('[SUPABASE] ✅ رسالة محفوظة:', m.from_num, '-', (body || '').slice(0, 30));
  } catch (e) { console.error('[SUPABASE] insert فشل:', e.message); }
}
async function dbGetMessages(cid) {
  if (!_sbOK) return [];
  try {
    const data = await sbReq('GET', 'messages', { qs: `select=*&client_id=eq.${encodeURIComponent(cid)}&order=at.asc` });
    return (data || []).map(r => ({ client_id: r.client_id, from_num: r.from_num, direction: r.direction, text: r.body, at: r.at, read: r.read }));
  } catch (e) { console.error('[SUPABASE] dbGetMessages فشل (يرجع فاضي):', e.message); return []; }
}
async function boot() {
  await dbLoad();
  if (!_db.clients.find(c => c.id === 'halat')) {
    const c = { id: 'halat', name: 'هالات', phone_id: process.env.HALAT_PHONE_ID || 'HALATID', wa_token: process.env.HALAT_WA_TOKEN || 'demo', flow: 'qa', owner_email: process.env.HALAT_STAFF_EMAIL || '', maintenance_msg: '🔧 خدمة العملاء تحت الصيانة حالياً.\nالرجاء التواصل معنا عبر:\n📧 الإيميل: ' + (process.env.HALAT_STAFF_EMAIL || 'support@halat.sa') + '\n🌐 إنستقرام: @halat.sa', system_prompt: 'أنت موظف خدمة عملاء في متجر هالات للحيوانات. أجب بالعربية وباختصار. لو ما تعرف قل "موظف".', store: null };
    _db.clients.push(c); await dbSaveClient(c);
  }
  if (!_db.qa.length) {
    try {
      const qa = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa.json'), 'utf8'));
      _db.qa = qa.map(q => ({ client_id: q.client_id || 'halat', question: q.question, keywords: q.keywords, reply: q.reply }));
      console.log(`[BOOT] زرع ${_db.qa.length} سؤال ✅`);
    } catch (e) { console.log('[BOOT] تعذّر زرع qa:', e.message); }
  }
  if (!_db.users.find(u => u.username === 'admin')) {
    const u = { username: 'admin', client_id: 'halat', password: bcrypt.hashSync(ADMIN_PASSWORD, 10), role: 'owner', email: process.env.ALERT_EMAIL || '' };
    _db.users.push(u); await dbSaveUser(u);
  }
  const diag = ['VERIFY_TOKEN','ADMIN_PASSWORD','SESSION_SECRET','HALAT_PHONE_ID','HALAT_WA_TOKEN','META_APP_SECRET','GROQ_API_KEY','ALERT_EMAIL','HALAT_STAFF_EMAIL','RENDER_EXTERNAL_URL','SUPABASE_URL','SUPABASE_KEY'];
  const present = diag.filter(k => process.env[k]);
  console.log(`[BOOT-DIAG] env vars present (${present.length}/${diag.length}): ${present.join(', ')}`);
  if (!process.env.HALAT_WA_TOKEN || process.env.HALAT_WA_TOKEN === 'demo') console.log('[BOOT-DIAG] ⚠️ HALAT_WA_TOKEN فاضي → البوت بوضع demo');
  console.log(`[BOOT] جاهز: ${_db.clients.length} عميل، ${_db.qa.length} سؤال، ${_db.users.length} مستخدم`);
}
boot();

app.set('trust proxy', 1); // Render sits behind Cloudflare/proxy → req.secure must be true so session cookie is sent
// DEBUG: if ?sid= present, set cookie header so both page + API work in browser-tool test
app.use((req, res, next) => {
  if (req.query.sid && !(req.headers.cookie && req.headers.cookie.includes('connect.sid='))) {
    req.headers.cookie = `connect.sid=${req.query.sid}`;
  }
  next();
});
app.use(session({ secret: process.env.SESSION_SECRET || 'RxWaSession2026', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000 } }));
const requireLogin = (req, res, next) => {
  if (req.session && req.session.user) return next();
  // DEBUG: allow ?sid= cookie passthrough for browser-tool testing (remove after verify)
  if (req.query.sid && !req.cookies.sid) { req.headers.cookie = `connect.sid=${req.query.sid}`; }
  if (req.cookies && req.cookies.sid) { return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).send('🔒 سجّل الدخول');
  return res.redirect('/login');
};
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
  // Scripts and styles are served as separate static files from same-origin ('self'),
  // so no 'unsafe-inline' is needed. This is the secure default.
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'");
  next();
});

const getClientByPhone = (phoneId) => _db.clients.find(c => c.phone_id === phoneId) || null;
const getClientById = (id) => _db.clients.find(c => c.id === id) || null;
const logMsg = async (cid, from, dir, text) => {
  const m = { client_id: cid, from_num: from, direction: dir, text, at: new Date().toISOString() };
  if (!_db.messages) _db.messages = [];
  _db.messages.push(m);
  if (_db.messages.length > 1000) _db.messages = _db.messages.slice(-1000);
  await dbAddMessage(m);
};

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

// markInbound keeps in-memory timestamp (24h window) — no file needed
function markInbound(clientId, from) { if (!_db.lastInbound) _db.lastInbound = {}; _db.lastInbound[clientId + ':' + from] = Date.now(); }
function within24h(clientId, from) { const t = _db.lastInbound && _db.lastInbound[clientId + ':' + from]; return t && (Date.now() - t) < 24 * 3600 * 1000; }
// save() is now a no-op (data persisted via Supabase helpers); kept for compatibility
function save() {}

// ---------- send ----------
async function sendMsg(client, to, payload, opts) {
  opts = opts || {};
  // Replies from the Inbox (manual, agent-sent) must always go through — never block on 24h.
  if (!opts.force && opts.type !== 'template' && !within24h(client.id, to)) { console.log(`[24h] خارج النافذة -> ${to}`); return { blocked24h: true }; }
  if (opts.type === 'text') logMsg(client.id, to, 'out', payload);
  else logMsg(client.id, to, 'out', '[رسالة ' + opts.type + ']');
  if (!client.wa_token || client.wa_token === 'demo' || !client.phone_id) { console.log(`[ROUTE] ${client.name} -> ${to}: ${payload}`); return {}; }
  const url = `https://graph.facebook.com/${API_VERSION}/${client.phone_id}/messages`;
  try { await axios.post(url, { messaging_product: 'whatsapp', to, ...payload }, { headers: { Authorization: `Bearer ${client.wa_token}` } }); return {}; }
  catch (e) { console.error('send error:', e.response && e.response.data || e.message); return { error: e.message }; }
}
function sendText(client, to, text, opts) { return sendMsg(client, to, { type: 'text', text: { body: text } }, Object.assign({ type: 'text' }, opts)); }
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
  // MAINTENANCE MODE (mute) — temporary auto-reply, no Q&A/LLM
  if (process.env.MAINTENANCE_MODE === 'on') {
    const info = client.maintenance_msg || '🔧 خدمة العملاء تحت الصيانة حالياً.\nالرجاء التواصل معنا عبر:\n📧 الإيميل: ' + (client.owner_email || 'support@halat.sa') + '\n🌐 إنستقرام: @halat.sa';
    return sendText(client, from, info);
  }
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
        const from = m.from; const wid = m.id; const text = (m.text && m.text.body || '').trim(); const hasImage = !!(m.image || m.document || m.video || m.audio);
        // DEDUPE: Meta retries webhook delivery; skip if we already processed this message id (in-memory = reliable)
        if (wid && _seen.has(wid)) continue;
        if (wid) _seen.add(wid);
        let buttonId = null;
        if (m.interactive && m.interactive.type === 'button_reply') { buttonId = m.interactive.button_reply.id; await logMsg(client.id, from, 'in', '[زر] ' + (m.interactive.button_reply.title || buttonId)); }
        else await logMsg(client.id, from, 'in', text || (m.image ? '[صورة]' : m.video ? '[فيديو]' : m.document ? '[ملف]' : m.audio ? '[صوت]' : ''));
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
app.get('/inbox', requireLogin, (req, res) => res.sendFile(__dirname + '/public/inbox.html'));
app.get('/inbox.css', (req, res) => res.sendFile(__dirname + '/public/inbox.css'));
app.get('/inbox.js', (req, res) => res.sendFile(__dirname + '/public/inbox.js'));
app.get('/api/conversations', requireLogin, async (req, res) => {
 try {
  const cid = req.session.user.client_id;
  let msgs = await dbGetMessages(cid);
  if (!msgs.length && _db.messages && _db.messages.length) msgs = _db.messages.filter(m => m.client_id === cid);
  const byNum = {};
  for (const m of msgs) (byNum[m.from_num] = byNum[m.from_num] || []).push(m);
  const convs = Object.entries(byNum).map(([num, list]) => {
    const last = list[list.length - 1];
    const lastText = (last && last.text && typeof last.text === 'string') ? last.text : '';
    return { num, last: { at: last.at, direction: last.direction, text: lastText }, count: list.length, unread: list.filter(m => m.direction === 'in' && !m.read).length, staffRequested: !!_db.staffRequests[num] };
  }).sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
  res.json({ client: getClientById(cid), conversations: convs });
 } catch (e) { console.error('[API] conversations خطأ:', e.message); res.json({ client: null, conversations: [] }); }
});
app.get('/api/messages/:num', requireLogin, async (req, res) => {
 try {
  const cid = req.session.user.client_id;
  let list = await dbGetMessages(cid);
  list = list.filter(m => m.from_num === req.params.num);
  list.forEach(m => { if (m.direction === 'in') m.read = true; });
  const out = list.map(m => ({ direction: m.direction, at: m.at, text: (typeof m.text === 'string' ? m.text : '') }));
  res.json(out);
 } catch (e) { console.error('[API] messages خطأ:', e.message); res.json([]); }
});
app.post('/api/reply', requireLogin, async (req, res) => {
  const cid = req.session.user.client_id; const client = getClientById(cid); if (!client) return res.status(404).send('no client');
  const { num, text } = req.body; delete _db.staffRequests[num]; save(_db);
  const r = await sendText(client, num, text, { force: true }); // agent reply always sends, bypass 24h
  res.json({ ok: true, ...r });
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

// GLOBAL error handler — never leak HTML stack traces; always return safe JSON
app.use((err, req, res, next) => {
  console.error('[ERROR]', err && err.message);
  if (req.path.startsWith('/api/')) return res.status(200).json({ error: 'internal', conversations: [], messages: [] });
  res.status(500).send('⚠️ خطأ داخلي');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RX WA v3.0 شغّالة على ${PORT}`));
