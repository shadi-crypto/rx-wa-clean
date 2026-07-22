// RX WA Inbox — Chatwoot-style frontend (consumes existing server API)
const $ = (s) => document.querySelector(s);
let convs = [], active = null;

function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function initial(n) { return (n || '؟').replace(/\D/g, '').slice(-2) || '؟'; }

async function loadConvs() {
  try {
    const r = await fetch('/api/conversations');
    const d = await r.json();
    $('#clientName').textContent = (d.isOwner ? 'صندوق الوارد (مالك)' : (d.client && d.client.name)) || 'صندوق الوارد';
    convs = (d.conversations || []).slice().sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
    renderConvs();
  } catch (e) { toast('تعذّر تحميل المحادثات'); }
}

function renderConvs() {
  const q = ($('#search').value || '').trim().toLowerCase();
  const list = convs.filter(c => !q || c.num.includes(q) || (c.last.text || '').toLowerCase().includes(q));
  $('#convList').innerHTML = list.length ? list.map(c => `
    <li class="conv ${c.num === active ? 'active' : ''}" data-num="${c.num}">
      <div class="avatar">${initial(c.num)}</div>
      <div class="conv-body">
        <div class="conv-name"><span>${c.num}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
        <div class="conv-last">${(c.last.text || '').slice(0, 42) || '—'}</div>
      </div>
    </li>`).join('')
  : '<div class="empty" style="padding:24px">لا توجد محادثات</div>';

  document.querySelectorAll('.conv').forEach(el => el.onclick = () => openConv(el.dataset.num));
}

async function openConv(num) {
  active = num;
  renderConvs();
  $('#convTitle').textContent = num;
  const c = convs.find(x => x.num === num);
  $('#convSub').textContent = c && c.staffRequested ? '🔔 طلب موظف' : 'واتساب';
  const r = await fetch('/api/messages/' + encodeURIComponent(num));
  const msgs = await r.json();
  $('#messages').innerHTML = msgs.length ? msgs.map(m => `
    <div class="msg ${m.direction === 'out' ? 'out' : 'in'}">
      ${escapeHtml(m.text || '')}
      <span class="t">${fmt(m.at)}</span>
    </div>`).join('')
  : '<div class="empty">لا رسائل بعد</div>';
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function escapeHtml(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function fmt(iso) { try { return new Date(iso).toLocaleString('ar', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

async function send() {
  const txt = $('#msgInput').value.trim();
  if (!txt || !active) return;
  $('#msgInput').value = '';
  try {
    const r = await fetch('/api/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num: active, text: txt })
    });
    const d = await r.json();
    if (d.ok) { toast('✅ أُرسلت'); openConv(active); loadConvs(); }
    else toast('⚠️ فشل الإرسال');
  } catch (e) { toast('⚠️ خطأ في الإرسال'); }
}

$('#sendBtn').onclick = send;
$('#msgInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#search').addEventListener('input', renderConvs);

// initial load
loadConvs();
setInterval(loadConvs, 8000); // auto-refresh
