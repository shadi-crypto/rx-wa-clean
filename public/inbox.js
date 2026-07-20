let cur = '';
let lastTs = 0;

function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

async function load() {
  try {
    const r = await fetch('/api/conversations', { credentials: 'include' });
    const d = await r.json();
    document.getElementById('cname').textContent = (d.client && d.client.name) || '';
    let maxTs = lastTs;
    (d.conversations || []).forEach(c => {
      const last = c.last || {};
      const ts = new Date(last.at || 0).getTime();
      if (!isNaN(ts) && ts > maxTs) maxTs = ts;
    });
    if (maxTs > lastTs) lastTs = maxTs;
    const unread = (d.conversations || []).reduce((s, c) => s + (c.unread || 0), 0);
    const staff = (d.conversations || []).filter(c => c.staffRequested).length;
    document.getElementById('bell').textContent =
      (unread ? (' 📨' + unread) : '') + (staff ? (' 🔔' + staff) : '');

    const list = document.getElementById('list');
    if (!d.conversations || !d.conversations.length) {
      list.innerHTML = '<div class="empty">لا محادثات بعد</div>';
      return;
    }
    list.innerHTML = d.conversations.map(c => {
      const last = c.last || {};
      const txt = (typeof last.text === 'string') ? last.text :
        (last.text && last.text.body ? last.text.body : '');
      return `<div class="conv ${c.num === cur ? 'active' : ''}" data-num="${c.num}">
        <div class="num">${c.num}${c.staffRequested ? ' <span class="staff">موظف</span>' : ''}</div>
        <div class="prev">${(txt || '').slice(0, 30)}</div>
        <div class="meta">${c.unread ? '<span class="badge">' + c.unread + '</span>' : '<span></span>'}</div>
      </div>`;
    }).join('');
  } catch (e) {
    console.error('load err', e);
  }
}

document.getElementById('list').addEventListener('click', e => {
  const el = e.target.closest('.conv');
  if (el && el.dataset.num) openC(el.dataset.num);
});

async function openC(num) {
  cur = num;
  try {
    const r = await fetch('/api/messages/' + encodeURIComponent(num), { credentials: 'include' });
    const d = await r.json();
    document.getElementById('msgs').innerHTML = (d || []).map(m => {
      const t = (typeof m.text === 'string') ? m.text :
        (m.text && m.text.body ? m.text.body : '');
      return '<div class="b ' + (m.direction || 'in') + '">' + (t || '') + '</div>';
    }).join('');
    const ms = document.getElementById('msgs');
    ms.scrollTop = ms.scrollHeight;
  } catch (e) {}
  load();
}

async function send() {
  if (!cur) return;
  const t = document.getElementById('txt').value;
  if (!t) return;
  await fetch('/api/reply', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num: cur, text: t })
  });
  document.getElementById('txt').value = '';
  openC(cur);
}

load();
setInterval(load, 4000);
