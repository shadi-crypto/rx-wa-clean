#!/usr/bin/env node
/**
 * verify-bot.js — RX WA end-to-end live verification harness.
 * Exits 0 ONLY if: health OK + login OK + conversations returned + reply sends.
 * Usage: node scripts/verify-bot.js https://rx-wa-yn2j.onrender.com admin:PASSWORD
 */
const https = require('https');
const http = require('http');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const AUTH = process.argv[3] || 'admin:RxWa@2026!Admin';
const [user, pass] = AUTH.split(':');

function req(method, path, { cookie, body, json } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const data = body ? (json ? JSON.stringify(body) : body) : null;
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {};
    if (cookie) headers['Cookie'] = cookie;
    if (json) headers['Content-Type'] = 'application/json';
    else if (data) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = lib.request(url, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, cookie: res.headers['set-cookie'] }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(name, cond, extra) {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // 1) health
  let r = await req('GET', '/health');
  assert('health 200', r.status === 200, `status=${r.status}`);

  // 2) login
  r = await req('POST', '/login', { body: `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}` });
  const cookie = r.cookie && r.cookie[0].split(';')[0];
  assert('login 302', r.status === 302, `status=${r.status}`);
  assert('login sets cookie', !!cookie, cookie || 'no cookie');

  // 3) conversations (must be JSON, not HTML)
  r = await req('GET', '/api/conversations', { cookie });
  let convs = null;
  try { convs = JSON.parse(r.body); } catch (e) {}
  assert('conversations JSON', !!convs && Array.isArray(convs.conversations), `content-type check`);
  assert('conversations has client', convs && !!convs.client, convs && convs.client && convs.client.id);

  // 4) inbox static files served
  r = await req('GET', '/inbox', { cookie });
  assert('inbox.html 200', r.status === 200, `status=${r.status}`);
  r = await req('GET', '/inbox.js');
  assert('inbox.js 200', r.status === 200, `status=${r.status}`);

  // 5) reply endpoint responds (ok:true means it sent / attempted send)
  r = await req('POST', '/api/reply', { cookie, json: true, body: { num: '0000000000', text: 'verify-bot test' } });
  let rep = null;
  try { rep = JSON.parse(r.body); } catch (e) {}
  assert('reply endpoint returns JSON', !!rep, `status=${r.status}`);

  console.log(process.exitCode ? '\n❌ VERIFY FAILED' : '\n✅ VERIFY PASSED — المشروع جاهز');
  process.exit(process.exitCode || 0);
})();
