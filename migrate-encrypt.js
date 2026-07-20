// one-off migration: encrypt wa_token at rest + drop owner_email
// run locally with: node migrate-encrypt.js (needs .env with SUPABASE_URL + SUPABASE_KEY + STORE_ENC_KEY)
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const KEY = (process.env.STORE_ENC_KEY || '').padEnd(32, '0').slice(0, 32);
if (!SB_URL || !SB_KEY || KEY.length !== 32) { console.error('missing SUPABASE_URL / SUPABASE_KEY / STORE_ENC_KEY (32 bytes)'); process.exit(1); }

function enc(v) {
  if (!v) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const e = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
  const t = c.getAuthTag();
  return 'v1:' + iv.toString('hex') + ':' + t.toString('hex') + ':' + e.toString('hex');
}

const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

(async () => {
  const { data: clients } = await axios.get(`${SB_URL}/rest/v1/clients?select=*`, { headers });
  console.log(`[MIGRATE] ${clients.length} client(s) found`);
  let changed = 0;
  for (const c of clients) {
    const needsEnc = c.wa_token && !c.wa_token.startsWith('v1:');
    const needsDrop = c.owner_email && c.owner_email.length;
    if (!needsEnc && !needsDrop) { console.log(`  - ${c.id}: OK (skip)`); continue; }
    const patch = {};
    if (needsEnc) { patch.wa_token = enc(c.wa_token); console.log(`  - ${c.id}: encrypt wa_token`); }
    if (needsDrop) { patch.owner_email = ''; console.log(`  - ${c.id}: drop owner_email (${c.owner_email})`); }
    await axios.patch(`${SB_URL}/rest/v1/clients?id=eq.${encodeURIComponent(c.id)}`, patch, { headers });
    changed++;
  }
  console.log(`[MIGRATE] done. ${changed} client(s) updated.`);
})().catch(e => { console.error('[MIGRATE] FAIL:', e.response && e.response.data || e.message); process.exit(1); });
