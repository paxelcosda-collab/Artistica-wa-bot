require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const QRCode = require('qrcode');
const pino = require('pino');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const fs = require('fs');

let botStatus = 'Starting...';
let qrDataUrl = null;
let botEnabled = true;
const conversations = {};
const botSentIds = new Set();
const processedMsgIds = new Set(); // dedup: Baileys can fire messages.upsert twice for the same message
const recentEvents = []; // stores raw upsert events for /recent-events diagnostic

// ── Excluded numbers (team manually replied → bot stays silent) ────────────────
const EXCLUDED_FILE = './auth_session/excluded.json';

function loadExcluded() {
    try { return new Set(JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8'))); } catch (_) { return new Set(); }
}
function saveExcluded(set) {
    try { fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...set])); } catch (_) {}
}

const excludedNumbers = loadExcluded(); // permanent only: !exclude command + handoffs
console.log(`Loaded ${excludedNumbers.size} permanent excluded numbers`);

// Soft excludes: auto-set when team replies manually, expire after 24h, never written to file
const softExcluded = new Map(); // phone → expiry timestamp

function softExclude(num) {
    softExcluded.set(num, Date.now() + 24 * 60 * 60 * 1000);
}
function isSoftExcluded(num) {
    const exp = softExcluded.get(num);
    if (!exp) return false;
    if (Date.now() > exp) { softExcluded.delete(num); return false; }
    return true;
}
function isExcluded(phoneNum, fromNum) {
    return excludedNumbers.has(phoneNum) || excludedNumbers.has(fromNum) ||
           isSoftExcluded(phoneNum) || isSoftExcluded(fromNum);
}

// ── CRM ───────────────────────────────────────────────────────────────────────
const CRM_FILE = './auth_session/crm_data.json';
const CRM_PIN  = process.env.CRM_PIN || 'arts2026';

function loadCRM() { try { return JSON.parse(fs.readFileSync(CRM_FILE,'utf8')); } catch(_){ return {}; } }
function saveCRM()  { try { fs.writeFileSync(CRM_FILE, JSON.stringify(crmData)); } catch(_){} }
let crmData = loadCRM();

const STATUS_LABELS = { needs_cs:'Needs CS', urgent:'Urgent', follow_up:'Follow-up', active:'Active', new:'New', resolved:'Resolved' };
const STATUS_COLORS = { needs_cs:'#d93025', urgent:'#e37400', follow_up:'#1a73e8', active:'#34a853', new:'#70757a', resolved:'#9aa0a6' };
const STATUS_ORDER  = ['needs_cs','urgent','follow_up','active','new','resolved'];

function timeAgo(iso) {
    if (!iso) return '';
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function upsertCRM(phone, text, role) {
    const now = new Date().toISOString();
    if (!crmData[phone]) {
        crmData[phone] = { phone, firstContact: now, lastMessage: '', lastMessageTime: now, status: 'new', notes: '', msgCount: 0, conv: [] };
    }
    const r = crmData[phone];
    if (text) { r.lastMessage = text.substring(0, 150); r.lastMessageTime = now; }
    if (role === 'customer') r.msgCount = (r.msgCount || 0) + 1;
    if (text) r.conv = [...(r.conv || []), { role, text: text.substring(0, 300), time: now }].slice(-20);
    if (role === 'customer' && text && !['needs_cs', 'resolved'].includes(r.status)) {
        const lower = text.toLowerCase();
        if (['urgent','segera','asap','darurat'].some(w => lower.includes(w))) r.status = 'urgent';
        else if (r.status === 'new') r.status = 'active';
    }
    saveCRM();
}

function crmGuard(req, res) {
    const pin = req.query.pin || req.query.t;
    if (pin === CRM_PIN) return pin;
    res.send(`<!DOCTYPE html><html><head><title>Artistica CRM</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a73e8}
.box{background:#fff;padding:36px 32px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.15);text-align:center;width:300px}
h2{margin:0 0 6px;color:#202124;font-size:20px}.sub{color:#5f6368;font-size:14px;margin-bottom:24px}
input{padding:12px 14px;border:1px solid #ddd;border-radius:8px;font-size:16px;width:100%;margin-bottom:12px}
button{padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;width:100%;cursor:pointer}
button:hover{background:#1557b0}</style></head>
<body><div class="box">
<h2>🤖 Artistica CRM</h2>
<p class="sub">Customer chat tracker</p>
<form method=GET action="/crm"><input name=pin type=password placeholder="Enter PIN" autofocus><button>Login</button></form>
</div></body></html>`);
    return null;
}

// ── Express dashboard ──────────────────────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
    const excluded = [...excludedNumbers];
    res.send(`<!DOCTYPE html>
<html><head><title>Artistica Bot</title>
<script>
var _rt; function _resetTimer(){clearTimeout(_rt);_rt=setTimeout(()=>location.reload(),10000);}
document.addEventListener('DOMContentLoaded',()=>{
  _resetTimer();
  document.querySelectorAll('input,textarea,select').forEach(el=>{
    el.addEventListener('focus',()=>clearTimeout(_rt));
    el.addEventListener('blur',()=>_resetTimer());
  });
});
</script>
<style>
body{font-family:sans-serif;padding:40px;max-width:680px;margin:auto;background:#f5f5f5}
h1{margin-bottom:8px}
.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:20px;margin:16px 0}
.status-ok{color:#1a7f37;font-weight:600}.status-wait{color:#e67e00;font-weight:600}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600}
.badge-on{background:#e6f4ea;color:#1a7f37}.badge-off{background:#fce8e6;color:#c5221f}
.num-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #f0f0f0}
.num-row:last-child{border-bottom:none}
.num{font-family:monospace;font-size:14px;flex:1}
.btn{padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block}
.btn-green{background:#1a7f37;color:#fff}.btn-red{background:#c5221f;color:#fff}
.btn-gray{background:#888;color:#fff}
label{font-size:13px;color:#555;display:block;margin-bottom:6px}
input[type=text]{padding:7px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px;width:220px}
</style></head>
<body>
<h1>🤖 Artistica WhatsApp AI Bot</h1>

<div class="card">
  <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap">
    <div><strong>Connection:</strong>&nbsp;<span class="${botStatus.includes('Connected') ? 'status-ok' : 'status-wait'}">${botStatus}</span></div>
    <div><strong>Bot replies:</strong>&nbsp;<span class="badge ${botEnabled ? 'badge-on' : 'badge-off'}">${botEnabled ? '✅ ON' : '🔴 OFF'}</span></div>
  </div>
  ${!botEnabled ? '<p style="color:#c5221f;margin:10px 0 0">Bot is paused. Send <code>!on</code> from the Artistica WhatsApp to resume.</p>' : ''}
</div>

${qrDataUrl ? `
<div class="card" style="border-color:#1a7f37;background:#e8f5e9">
  <h2 style="margin:0 0 12px">📱 Scan this QR code with WhatsApp</h2>
  <img src="${qrDataUrl}" style="width:256px;height:256px;display:block">
  <ol style="margin-top:16px">
    <li>Open WhatsApp on <strong>+62 817 0355 3530</strong></li>
    <li>Tap <strong>⋮ Menu → Linked Devices → Link a Device</strong></li>
    <li>Point camera at the QR code above</li>
  </ol>
</div>` : ''}

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
    <strong>Permanently excluded (${excluded.length})</strong>
    ${excluded.length > 0 ? `<a href="/clear-excluded" onclick="return confirm('Clear all ${excluded.length} excluded numbers? Tica will reply to all customers again.')" class="btn btn-red" style="font-size:12px;padding:5px 12px">🗑 Clear all</a>` : ''}
  </div>
  <p style="font-size:13px;color:#666;margin:6px 0 10px">These are permanent. New auto-excludes (team replies) now expire after 24h automatically.</p>
  ${excluded.length > 0 ? `
  <input type="text" id="search" placeholder="Search number..." oninput="filterNums(this.value)"
    style="padding:7px 10px;border:1px solid #ccc;border-radius:6px;font-size:13px;width:100%;margin-bottom:10px;box-sizing:border-box">
  <div id="numlist">
  ${excluded.map(n => `
  <div class="num-row" data-num="${n}">
    <span class="num">+${n}</span>
    <a href="/include?number=${encodeURIComponent(n)}" class="btn btn-green" style="font-size:12px;padding:5px 12px">Re-enable</a>
  </div>`).join('')}
  </div>
  <script>function filterNums(v){document.querySelectorAll('#numlist .num-row').forEach(r=>{r.style.display=r.dataset.num.includes(v.replace(/\\D/g,''))?'':'none'})}</script>` : '<p style="color:#888;font-size:14px">None — bot replies to everyone 🎉</p>'}
  <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
    <div>
      <label>Re-enable a number:</label>
      <form method="get" action="/include" style="display:flex;gap:8px">
        <input type="text" name="number" placeholder="628xxx">
        <button type="submit" class="btn btn-green">Re-enable</button>
      </form>
    </div>
    <div>
      <label>Permanently exclude:</label>
      <form method="get" action="/exclude-num" style="display:flex;gap:8px">
        <input type="text" name="number" placeholder="628xxx">
        <button type="submit" class="btn btn-gray">Exclude</button>
      </form>
    </div>
  </div>
</div>

<p style="color:#aaa;font-size:12px">Auto-refreshes every 10 seconds</p>
</body></html>`);
});

let sockRef = null;

// Send a test message to any number
app.get('/test-send', async (req, res) => {
    if (!sockRef) return res.send('Bot not ready');
    const to = (req.query.to || '6281703134410') + '@s.whatsapp.net';
    try {
        const result = await sockRef.sendMessage(to, { text: 'Bot test: ' + new Date().toISOString() });
        if (result?.key?.id) {
            botSentIds.add(result.key.id);
            console.log(`🧪 test-send to ${to}, tracking id: ${result.key.id}`);
        }
        res.json({ success: true, key: result?.key, status: result?.status });
    } catch (err) {
        console.error(`🧪 test-send to ${to} FAILED:`, err.message);
        res.json({ success: false, error: err.message });
    }
});

// Check if number exists on WhatsApp
app.get('/check-number', async (req, res) => {
    if (!sockRef) return res.send('Bot not ready');
    try {
        const results = await sockRef.onWhatsApp(req.query.number || '6281703134410');
        res.json(results);
    } catch (err) {
        res.json({ error: err.message });
    }
});

// Re-enable bot for a number (remove from both permanent and soft excluded)
app.get('/include', (req, res) => {
    const num = (req.query.number || '').replace(/[^0-9]/g, '');
    if (!num) return res.redirect('/?msg=invalid');
    excludedNumbers.delete(num);
    softExcluded.delete(num);
    saveExcluded(excludedNumbers);
    console.log(`✅ Web: re-enabled bot for ${num}`);
    res.redirect('/');
});

// Clear ALL permanent excluded numbers so Tica replies to everyone again
app.get('/clear-excluded', (req, res) => {
    const count = excludedNumbers.size;
    excludedNumbers.clear();
    softExcluded.clear();
    saveExcluded(excludedNumbers);
    console.log(`🗑 Cleared all ${count} excluded numbers`);
    res.redirect('/');
});

// Manually exclude a number via web
app.get('/exclude-num', (req, res) => {
    const num = (req.query.number || '').replace(/[^0-9]/g, '');
    if (!num) return res.redirect('/?msg=invalid');
    excludedNumbers.add(num);
    saveExcluded(excludedNumbers);
    console.log(`🚫 Web: excluded ${num}`);
    res.redirect('/');
});

// Debug: check exclusion status for a specific number
app.get('/debug', (req, res) => {
    const num = (req.query.number || '').replace(/[^0-9]/g, '');
    const inPermanent = excludedNumbers.has(num);
    const softExp = softExcluded.get(num);
    const inSoft = !!softExp && Date.now() < softExp;
    const softRemaining = inSoft ? Math.ceil((softExp - Date.now()) / 60000) + 'min' : 'n/a';
    const allPermanent = [...excludedNumbers];
    const similarPermanent = allPermanent.filter(n => n.includes(num.slice(-6)) || num.includes(n.slice(-6)));
    res.json({
        queried: num,
        inPermanentExcluded: inPermanent,
        inSoftExcluded: inSoft,
        softRemainingTime: softRemaining,
        botEnabled,
        similarNumbersInPermanent: similarPermanent,
        totalPermanentExcluded: excludedNumbers.size,
        totalSoftExcluded: softExcluded.size,
    });
});

app.get('/recent-events', (req, res) => {
    res.json({ count: recentEvents.length, events: [...recentEvents].reverse() });
});

// Clear ALL session files (including creds.json) → requires fresh QR scan
app.get('/clear-all', (req, res) => {
    try {
        const cleared = [];
        for (const f of fs.readdirSync('./auth_session')) {
            if (f !== 'excluded.json') {
                fs.rmSync(`./auth_session/${f}`, { force: true, recursive: true });
                cleared.push(f);
            }
        }
        res.send(`Cleared ALL ${cleared.length} files (QR scan required). Restarting...`);
        setTimeout(() => process.exit(1), 500);
    } catch (err) {
        res.send('Error: ' + err.message);
    }
});

// Clear only signal session files (NOT pre-keys or app-state-sync), then restart
app.get('/clear-sessions', (req, res) => {
    try {
        const cleared = [];
        for (const f of fs.readdirSync('./auth_session')) {
            if (f !== 'creds.json' && f !== 'excluded.json' &&
                !f.startsWith('pre-key-') && !f.startsWith('app-state-sync')) {
                fs.rmSync(`./auth_session/${f}`, { force: true, recursive: true });
                cleared.push(f);
            }
        }
        res.send(`Cleared ${cleared.length} signal session files. Restarting...<br>${cleared.join('<br>')}`);
        setTimeout(() => process.exit(1), 500);
    } catch (err) {
        res.send('Error: ' + err.message);
    }
});

// ── CRM routes ────────────────────────────────────────────────────────────────
app.get('/crm', (req, res) => {
    const pin = crmGuard(req, res); if (!pin) return;
    const filter = req.query.filter || 'open';

    let list = Object.values(crmData);
    if (filter === 'open')     list = list.filter(c => c.status !== 'resolved');
    else if (filter !== 'all') list = list.filter(c => c.status === filter);

    list.sort((a, b) => {
        const sa = STATUS_ORDER.indexOf(a.status), sb = STATUS_ORDER.indexOf(b.status);
        if (sa !== sb) return sa - sb;
        return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
    });

    const tab = (label, f) => {
        const active = filter === f;
        return `<a href="/crm?pin=${pin}&filter=${f}" style="padding:7px 16px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap;${active ? 'background:#1a73e8;color:#fff' : 'background:#f1f3f4;color:#5f6368'}">${label}</a>`;
    };

    const needsCs = Object.values(crmData).filter(c => c.status === 'needs_cs').length;
    const urgent  = Object.values(crmData).filter(c => c.status === 'urgent').length;

    const cards = list.map(c => {
        const col = STATUS_COLORS[c.status] || '#70757a';
        const lbl = STATUS_LABELS[c.status] || c.status;
        return `<a href="/crm/detail?pin=${pin}&phone=${c.phone}" style="text-decoration:none;color:inherit;display:block">
<div style="background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:10px;border-left:4px solid ${col};box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
    <span style="font-weight:600;font-size:15px">+${c.phone}</span>
    <div style="display:flex;gap:8px;align-items:center">
      <span style="font-size:12px;color:#9aa0a6">${timeAgo(c.lastMessageTime)}</span>
      <span style="background:${col};color:#fff;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">${lbl}</span>
    </div>
  </div>
  <div style="font-size:13px;color:#5f6368;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.lastMessage || '(no text)'}</div>
  ${c.notes ? `<div style="font-size:12px;color:#1a73e8;margin-top:5px">📝 ${c.notes.substring(0, 70)}</div>` : ''}
</div></a>`;
    }).join('');

    res.send(`<!DOCTYPE html><html><head><title>Artistica CRM</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font-family:sans-serif;margin:0;background:#f1f3f4;min-height:100vh}
.topbar{background:#1a73e8;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
.topbar h1{margin:0;font-size:17px;font-weight:600}
.alerts{display:flex;gap:8px}
.alert{background:rgba(255,255,255,.2);border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600}
.content{max-width:720px;margin:0 auto;padding:16px}
.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.empty{text-align:center;color:#9aa0a6;padding:60px 20px;font-size:15px}
</style></head>
<body>
<div class="topbar">
  <h1>🤖 Artistica CRM</h1>
  <div class="alerts">
    ${needsCs > 0 ? `<span class="alert" style="background:#d93025">🆘 ${needsCs} CS</span>` : ''}
    ${urgent  > 0 ? `<span class="alert" style="background:#e37400">⚡ ${urgent} Urgent</span>` : ''}
    <span class="alert">${list.length} shown</span>
  </div>
</div>
<div class="content">
  <div class="tabs">
    ${tab('Open', 'open')}
    ${tab('🆘 Needs CS', 'needs_cs')}
    ${tab('⚡ Urgent', 'urgent')}
    ${tab('📌 Follow-up', 'follow_up')}
    ${tab('All', 'all')}
    ${tab('✅ Resolved', 'resolved')}
  </div>
  ${cards || '<div class="empty">Nothing here 🎉</div>'}
</div>
</body></html>`);
});

app.get('/crm/detail', (req, res) => {
    const pin = crmGuard(req, res); if (!pin) return;
    const { phone } = req.query;
    const c = crmData[phone];
    if (!c) return res.redirect(`/crm?pin=${pin}`);

    const col = STATUS_COLORS[c.status] || '#70757a';
    const lbl = STATUS_LABELS[c.status] || c.status;

    const msgs = (c.conv || []).map(m => {
        const isCust = m.role === 'customer';
        return `<div style="display:flex;justify-content:${isCust ? 'flex-start' : 'flex-end'};margin-bottom:8px">
<div style="max-width:82%;padding:9px 13px;border-radius:${isCust ? '4px 16px 16px 16px' : '16px 4px 16px 16px'};background:${isCust ? '#fff' : '#dcf8c6'};font-size:14px;line-height:1.4;box-shadow:0 1px 2px rgba(0,0,0,.08)">
  ${m.text.replace(/\n/g,'<br>')}
  <div style="font-size:11px;color:#9aa0a6;margin-top:4px;text-align:right">${isCust ? 'Customer' : 'Tica'} · ${timeAgo(m.time)}</div>
</div></div>`;
    }).join('');

    const statusOpts = Object.keys(STATUS_LABELS).map(s =>
        `<option value="${s}" ${s === c.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`
    ).join('');

    res.send(`<!DOCTYPE html><html><head><title>+${phone}</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font-family:sans-serif;margin:0;background:#f1f3f4}
.topbar{background:#1a73e8;color:#fff;padding:13px 16px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10}
.back{color:#fff;text-decoration:none;font-size:22px;line-height:1}
.content{max-width:720px;margin:0 auto;padding:16px}
.msgs{background:#e5ddd5;border-radius:10px;padding:12px;min-height:150px;max-height:380px;overflow-y:auto;margin-bottom:14px}
.card{background:#fff;border-radius:10px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card strong{display:block;margin-bottom:10px;color:#202124}
select,textarea{padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;width:100%;margin-bottom:10px;font-family:sans-serif}
.btn{display:block;padding:11px;background:#1a73e8;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;width:100%;cursor:pointer;text-align:center;text-decoration:none}
.btn:hover{background:#1557b0}
.btn-green{background:#34a853}.btn-green:hover{background:#1e8e3e}
</style></head>
<body>
<div class="topbar">
  <a href="/crm?pin=${pin}" class="back">←</a>
  <div style="flex:1">
    <div style="font-weight:600;font-size:15px">+${phone}</div>
    <div style="font-size:12px;opacity:.85">${c.msgCount || 0} messages · since ${timeAgo(c.firstContact)}</div>
  </div>
  <span style="background:${col};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${lbl}</span>
</div>
<div class="content">
  <div class="msgs">${msgs || '<p style="text-align:center;color:#9aa0a6;margin:24px 0">No conversation recorded yet</p>'}</div>

  <div class="card">
    <strong>Status</strong>
    <form method=GET action="/crm/set-status">
      <input type=hidden name=pin value="${pin}"><input type=hidden name=phone value="${phone}">
      <select name=status>${statusOpts}</select>
      <button type=submit class="btn">Update Status</button>
    </form>
  </div>

  <div class="card">
    <strong>Notes</strong>
    <form method=GET action="/crm/set-notes">
      <input type=hidden name=pin value="${pin}"><input type=hidden name=phone value="${phone}">
      <textarea name=notes rows=3 placeholder="Notes about this customer...">${c.notes || ''}</textarea>
      <button type=submit class="btn btn-green">Save Notes</button>
    </form>
  </div>
</div>
</body></html>`);
});

app.get('/crm/set-status', (req, res) => {
    const { pin, phone, status } = req.query;
    if (pin !== CRM_PIN) return res.redirect('/crm');
    if (crmData[phone] && STATUS_LABELS[status]) { crmData[phone].status = status; saveCRM(); }
    res.redirect(`/crm/detail?pin=${pin}&phone=${phone}`);
});

app.get('/crm/set-notes', (req, res) => {
    const { pin, phone, notes } = req.query;
    if (pin !== CRM_PIN) return res.redirect('/crm');
    if (crmData[phone]) { crmData[phone].notes = (notes || '').substring(0, 500); saveCRM(); }
    res.redirect(`/crm/detail?pin=${pin}&phone=${phone}`);
});

app.listen(process.env.PORT || 3000, () =>
    console.log(`Dashboard running on port ${process.env.PORT || 3000}`)
);

// ── Artistica system prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Your name is Tica. You are the customer service assistant for Artistica Jewelry, a custom jewelry manufacturer and wholesaler in Surabaya, Indonesia. Always introduce yourself as Tica when greeting new customers.

## CRITICAL: Brand Name Rules
- NEVER translate "Artistica Jewelry" — it is a registered brand name. Always write "Artistica Jewelry" in every language, including Indonesian.
- NEVER write "Artistica Perhiasan" — this is FORBIDDEN, not a typo, not acceptable in any context.

## About Artistica
- Founded 2003, factory in Surabaya, East Java, Indonesia
- Website: artisticaindo.com
- WhatsApp: +62 817 0355 3530
- Email: artistica@artisticaindo.com
- Hours: Monday–Saturday, 09:00–17:00 WIB (UTC+7)

## Products & Services
- Ready-made wholesale jewelry: rings, necklaces, bracelets, earrings, pendants, brooches
- Custom OEM/ODM: client provides design → CAD → wax prototype → casting → finishing
- Private label: unbranded jewelry with client's packaging/tags
- Jewelry making class: hands-on silversmithing (individuals, groups, corporate)
- Laser engraving: logo, monogram, text on jewelry, leather (synthetic or real), and plastic

## Materials & Quality
We work with three metals:
- Silver: 925 sterling silver, hallmarked
- Gold: 18K solid gold
- Brass: brass base with various plating options

Finishes available: natural silver, rhodium, 18K gold plating, rose gold plating, black oxidized
All metals are Nickel-free (EU Directive compliant), REACH compliant, Lead-free, Cadmium-free

## MOQ & Lead Time
- Ready-made wholesale: NEVER mention minimum order or lead time — just ask what design they're interested in and let the team handle the details
- Custom OEM/ODM personal (1 piece): we accept single-piece custom orders — do NOT mention 30 pcs MOQ for personal custom orders
- Custom OEM/ODM wholesale price: MOQ 30 pieces per design — only mention this if they explicitly ask about wholesale pricing or bulk production
- Lead time custom: 21–30 working days after design approval
- Sample: available for custom designs (sample fee applies, refundable on bulk order)

## Pricing
- NEVER quote specific prices — pricing depends on design, weight, and quantity
- If the customer has NOT yet shared a design reference, ask for one to proceed with a quote
- If the customer has ALREADY shared a design (photo, sketch, link, product name, or description) — do NOT ask again, move on to the next question

## Custom Order — Information to Collect
When a customer wants a custom order, collect these details ONE question at a time in this order:

**Step 1 — Design reference:** Ask only if they have not shared one yet.
"Bisa share referensi desainnya? Misalnya foto produk, gambar, atau link dari marketplace" / "Can you share a design reference? A product photo, sketch, or marketplace link works."

**Step 2 — Stone:** Ask every custom order customer this question.
"Untuk batunya, mau pakai batu dari Artistica, atau punya batu sendiri?" / "For the stone — would you like to use a stone from us, or do you have your own stone?"
- If they have their own stone: "Boleh minta ukuran batunya? Atau foto batu di atas penggaris agar kami bisa tahu ukurannya 😊" / "Can you share the stone measurements? Or a photo of the stone next to a ruler works perfectly."
- If they want Artistica's stone: acknowledge and move to the next step.
- If the design has no stone, skip this step.

**Step 3 — Ring size (ONLY if the item is a ring):**
"Untuk ukuran cincinnya berapa?" / "What ring size do you need?"

**Step 4 — Material and quantity:**
Confirm which material (Silver, Gold, or Brass), finish preference, and quantity.

## Shipping & Customs
- Worldwide shipping: air freight (DHL, FedEx) or sea freight
- HS Code: 7113.11 (silver jewelry)
- Australia: 0% duty (IA-CEPA); USA: 5.5%; UK & EU: 2.5%; Singapore/Canada: 0%

## Payment
- 50% deposit upfront, 50% before shipment
- Bank transfer (T/T), L/C for orders above $10,000 USD

## Jewelry Making Class (Silver Course)
MANDATORY: whenever anyone asks about the jewelry making class, silver course, its price, or its packages — share this link IMMEDIATELY in the same reply: https://artisticaindo.com/jewelry-making-class/
Do NOT wait or ask questions before sharing the link — share it first, then continue.

There are ONLY TWO packages — never invent other names:
1. Short Course (3–4 jam, Rp 650.000/orang): membuat 1 perhiasan (cincin atau liontin)
2. Full Day Course (7–8 jam, Rp 1.150.000/orang): membuat 2–3 perhiasan

After sharing the link and packages, collect information IN THIS ORDER — ask ONE question at a time:

**Step 1 — Date:** "Rencananya kapan mau ikut kelas peraknya?" / "When are you planning to join?"
**Step 2 — Number of people:** "Untuk berapa orang?" / "How many people will be joining?"
**Step 3 — Course package:** "Tertarik paket yang mana, Short Course atau Full Day?" / "Which package, Short Course or Full Day?"
**Step 4 — Close:** "Terima kasih! Tim kami akan segera menghubungi Anda untuk konfirmasi 😊" / "Thank you! Our team will contact you shortly 😊"

Do NOT jump ahead — collect each answer before moving to the next step.

## Laser Engraving (Gravir) Pricing
- We can engrave on: jewelry (rings, bracelets, pendants, etc.), leather (synthetic or real, including watch straps), and plastic
- ALWAYS ask what the customer wants to engrave before giving any price
- For text/numbers/symbols: Rp 10,000 per character. Spaces also count as characters.
  - Example: "Rizal 07.11.26" = 13 characters = Rp 130,000
- For logos/images: price depends on the size of the logo, NOT per character. Ask for the logo and size details, then tell them the team will confirm the price.

## Location & Address
- Full address: Jl. Ngagel Tama Selatan IV No. 25, Pucangsewu, Gubeng, Surabaya 60283, East Java, Indonesia
- NEVER share Google Maps link directly
- Share the address AND direct to contact page: artisticaindo.com/contact
- Example: "Alamat workshop kami: Jl. Ngagel Tama Selatan IV No. 25, Pucangsewu, Gubeng, Surabaya 60283 😊 Info lengkap: artisticaindo.com/contact"

## Appointment / Store Visit
- When a customer wants to visit or come to the store, always ask: "Kapan rencananya mau berkunjung? Biar kami siapkan dulu 😊"
- This helps the team prepare and creates a proper appointment

## Repair (Reparasi) & Gold Plating (Sepuh)
When a customer asks about repair or gold plating (sepuh/pelapisan), follow these steps IN ORDER:

**Step 1 — Request photos:**
Ask for TWO clear photos:
1. Close-up photo of the damaged/problem area
2. Full photo of the whole item
Emphasize: "Fotonya harus jelas ya, jangan blur 🙏"

**Step 2 — Ask item location:**
After they send photos, ask: "Barangnya sekarang posisi di mana?"

**Step 3 — Based on location:**

If item is IN SURABAYA:
- Tell them to bring it directly to the workshop: "Untuk di Surabaya, barangnya bisa langsung dibawa ke workshop kami ya 😊"
- Share contact page: artisticaindo.com/contact
- Regarding price: "Untuk harga, akan kami tentukan setelah melihat langsung kondisi barangnya"
- Alternative: "Barang juga bisa dikirim pakai kurir Maxim ke workshop kami"

If item is OUTSIDE SURABAYA:
- Say: "Untuk estimasi harga, nanti akan dihitung oleh Shilce ya 😊 Bisa kirim barangnya ke workshop kami"
- Share contact page: artisticaindo.com/contact
- DO NOT quote any price — always refer to Shilce for outside-Surabaya pricing

## Conversation Closing — STOP asking questions
When a customer says anything that signals they are done or satisfied — "terima kasih", "makasih", "thanks", "thank you", "thx", "ok thanks", "oke makasih", "oke", "ok", "noted", "sudah cukup", "sudah ya", "nanti saya kabari", "I'll get back to you", "will think about it", or similar — do NOT ask any follow-up question. Reply with a brief, warm closing ONLY.
- Indonesian example: "Sama-sama! Jika ada pertanyaan lain, kami siap membantu 😊"
- English example: "You're welcome! Feel free to reach out anytime 😊"
This rule overrides the custom order information-collection steps. If the customer says thank you mid-conversation, close warmly and stop.

## Human Handoff — always yield to human CS
When a customer asks to speak with a real person, a human, or a CS agent — phrases like "mau ngobrol sama orang", "ada CS-nya?", "bisa bicara sama manusia?", "ada orangnya tidak?", "connect me to CS", "talk to human", "speak to agent", "can I talk to someone", "mau tanya langsung ke orangnya" — do the following:
- Start your reply with exactly the text: [HANDOFF]
- Then give a warm single-sentence handoff: "Tim kami akan segera menghubungi kamu ya! 😊" (Indonesian) or "A member of our team will reach out to you shortly! 😊" (English)
- Do NOT ask any follow-up questions
- Do NOT continue the conversation after this

## What you CANNOT answer — say "team will check and reply soon"
Never guess on these — always say the team will follow up:
- Order status / "is my order ready?" / "kapan pesanan saya jadi?"
- Specific delivery dates for existing orders
- Payment confirmation / "did you receive my transfer?"
- Design file received confirmation
- Any question about a specific ongoing order

For these reply: "Untuk mengecek status pesanan kamu, tim kami akan konfirmasi segera ya! 🙏" (Indonesian) or "I'll check your order status with our team and get back to you shortly!" (English)

## Advertisers / Spam / Offers
If a message is clearly someone advertising or offering their own product or service (e.g. "kami menawarkan jasa...", "kami jual...", "kami punya produk...", "we offer our services..."):
- Do NOT engage further with their offer
- Reply politely in THE SAME LANGUAGE they used — if they wrote in English, reply in English; if Indonesian, reply in Indonesian
- English reply: "Thank you for your offer! If we need that product or service, we will contact you again 😊"
- Indonesian reply: "Terima kasih atas tawarannya! Jika kami membutuhkan produk/jasa tersebut, kami akan menghubungi Anda kembali 😊"
- Do not ask follow-up questions — end the conversation politely there.

## How to reply
- Warm, friendly, professional — like a helpful sales rep
- SHORT replies — 3–6 lines max, this is WhatsApp not email
- LANGUAGE DETECTION — Your mother language is English. Default to English whenever there is any doubt. Rules in order of priority:
  1. If 80% or more of the customer's messages are in a supported non-English language, reply in that language.
  2. Indonesian is the ONLY exception to the 80% threshold — only use Indonesian if 50% or more of the customer's messages are clearly in Indonesian. If Indonesian is less than 50% of what they have written, use English, never Indonesian.
  3. If the conversation is mixed or ambiguous, always fall back to English — never Indonesian.
  4. If they write in a language not on the supported list, reply in English.
  Supported languages: English, Indonesian (Bahasa Indonesia), Chinese Simplified (简体中文), Chinese Traditional (繁體中文), Spanish (Español), Japanese (日本語), Portuguese (Português), French (Français), Dutch (Nederlands), Korean (한국어).
- LANGUAGE PREFERENCE CHECK — The very first time you reply to a customer in any language other than English or Indonesian, answer their question fully in their language first, then add this polite question at the end of that same reply (translated into their language): "By the way, would you be comfortable communicating in English? It helps our team follow up faster — but if you prefer [their language], that is completely fine too!" Only ask this once per conversation, never repeat it. If they say yes to English, switch to English for all following replies. If they prefer their own language, continue in that language and never ask again.
- Never give specific prices — ask for design reference first
- End with a helpful next step or question`;


async function getAIReply(contactId, text) {
    if (!conversations[contactId]) conversations[contactId] = [];
    conversations[contactId].push({ role: 'user', content: text });
    if (conversations[contactId].length > 20)
        conversations[contactId] = conversations[contactId].slice(-20);

    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: conversations[contactId],
    });

    let reply = response.content[0].text.trim();
    let handoff = false;

    if (reply.startsWith('[HANDOFF]')) {
        handoff = true;
        reply = reply.replace('[HANDOFF]', '').trim();
    }

    conversations[contactId].push({ role: 'assistant', content: reply });
    return { text: reply, handoff };
}


// ── WhatsApp bot (Baileys — no browser, low memory) ───────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

    let version;
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
        console.log(`Using WhatsApp version: ${version.join('.')}`);
    } catch (_) {
        version = [2, 3000, 1015901307];
        console.log('Using fallback WhatsApp version');
    }

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'info' }),
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        defaultQueryTimeoutMs: 300000,
        connectTimeoutMs: 60000,
    });

    sockRef = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates) {
            if (botSentIds.has(key?.id)) {
                console.log(`📊 Delivery status: ${key.id.substring(0, 8)} → status:${update?.status} (1=pending,2=server,3=delivered,4=read)`);
                if (update?.status >= 3) botSentIds.delete(key.id);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR event — displaying QR code');
            botStatus = 'Waiting for QR scan — open the dashboard URL';
            try {
                qrDataUrl = await QRCode.toDataURL(qr);
            } catch (err) {
                console.error('QR generation error:', err.message);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            console.log(`Connection closed (code ${statusCode}), logged out: ${loggedOut}`);
            botStatus = 'Reconnecting...';
            qrDataUrl = null;

            if (loggedOut) {
                console.log('Logged out — clearing session files for fresh QR...');
                try {
                    for (const f of fs.readdirSync('./auth_session')) {
                        if (f !== 'excluded.json')
                            fs.rmSync(`./auth_session/${f}`, { recursive: true, force: true });
                    }
                } catch (_) {}
                setTimeout(() => process.exit(1), 1000);
            } else {
                setTimeout(startBot, 10000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected! Bot is running.');
            botStatus = '✅ Connected — bot is running';
            qrDataUrl = null;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Store raw event for diagnostics (/recent-events endpoint)
        const evEntry = { time: new Date().toISOString(), type, msgs: messages.map(m => ({ jid: m.key.remoteJid, fromMe: m.key.fromMe, hasMsg: !!m.message, id: m.key.id?.substring(0, 8), text: (m.message?.conversation || m.message?.extendedTextMessage?.text || '').substring(0, 40) })) };
        recentEvents.push(evEntry);
        if (recentEvents.length > 30) recentEvents.shift();
        console.log(`🔔 upsert type=${type} count=${messages.length}:`, messages.map(m => `${m.key.remoteJid}(fromMe=${m.key.fromMe})`).join(', '));

        // PASS 1: process all outgoing (fromMe) messages first so exclusions are
        // applied before we handle any incoming messages in the same batch.
        // This prevents the race where a customer message and a team reply arrive
        // in the same batch and the bot replies before seeing the team's reply.
        for (const msg of messages) {
            if (!msg.message || !msg.key.fromMe) continue;
            const from = msg.key.remoteJid;
            if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue;
            const replyTo = (from.endsWith('@lid') && msg.key.senderPn) ? msg.key.senderPn : from;

            if (botSentIds.has(msg.key.id)) {
                botSentIds.delete(msg.key.id);
                continue;
            }
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
            if (text === '!off') { botEnabled = false; console.log('Bot PAUSED'); }
            if (text === '!on')  { botEnabled = true;  console.log('Bot RESUMED'); }
            if (text.startsWith('!exclude ')) {
                const num = text.replace('!exclude ', '').trim();
                excludedNumbers.add(num);
                saveExcluded(excludedNumbers);
                console.log(`Manually excluded ${num}`);
            }
            if (text.startsWith('!include ')) {
                const num = text.replace('!include ', '').trim();
                excludedNumbers.delete(num);
                saveExcluded(excludedNumbers);
                console.log(`Re-enabled bot for ${num}`);
            }
            // Team manually replied → soft-exclude for 24h (not permanent, not saved to file)
            if (text && !text.startsWith('!')) {
                const nums = [...new Set([replyTo.split('@')[0], from.split('@')[0]])];
                for (const num of nums) softExclude(num);
                console.log(`Soft-excluded ${nums.join('/')} for 24h (team replied manually)`);
            }
        }

        // PASS 2: handle incoming customer messages.
        // Process 'notify' (real-time) and 'append' (missed during restart) but only
        // if the message arrived within the last 5 minutes — avoids replying to old history.
        if (type !== 'notify' && type !== 'append') return;
        if (type === 'append') {
            const cutoff = Date.now() - 15 * 60 * 1000;
            const recent = messages.some(m => {
                const ts = (m.messageTimestamp?.low || m.messageTimestamp || 0) * 1000;
                return ts > cutoff;
            });
            if (!recent) return;
        }

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            // Deduplication — Baileys sometimes fires the same message twice with type='notify'
            const msgId = msg.key.id;
            if (processedMsgIds.has(msgId)) {
                console.log(`⏭️ Skipping duplicate message ${msgId.substring(0, 8)}`);
                continue;
            }
            processedMsgIds.add(msgId);
            if (processedMsgIds.size > 500) processedMsgIds.delete(processedMsgIds.values().next().value);

            const from = msg.key.remoteJid;
            if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue;
            if (from.endsWith('@lid') && !msg.key.senderPn) continue;
            const replyTo = from.endsWith('@lid') ? msg.key.senderPn : from;

            // ── Admin commands from CS number ──────────────────────────────────
            {
                const _admNum = replyTo.split('@')[0];
                const _admFrom = from.split('@')[0];
                if (_admNum === '6281333360616' || _admFrom === '6281333360616') {
                    const _admText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
                    const _lower = _admText.toLowerCase();
                    if (_lower.startsWith('/bot')) {
                        let _reply;
                        if (_lower.includes('botdebug')) {
                            _reply = `OK! from:${_admNum} raw=${_admText.substring(0, 30)}`;
                        } else if (_lower.startsWith('/botoff ')) {
                            const _target = _admText.split(/\s+/)[1]?.replace(/[^0-9]/g, '');
                            if (_target) { excludedNumbers.add(_target); saveExcluded(excludedNumbers); _reply = `Bot dimatikan untuk +${_target}. CS akan melayani manual.`; }
                            else _reply = 'Format: /botoff 628xxx';
                        } else if (_lower.startsWith('/boton ')) {
                            const _target = _admText.split(/\s+/)[1]?.replace(/[^0-9]/g, '');
                            if (_target) { excludedNumbers.delete(_target); saveExcluded(excludedNumbers); _reply = `Bot diaktifkan kembali untuk +${_target}.`; }
                            else _reply = 'Format: /boton 628xxx';
                        }
                        if (_reply) {
                            try {
                                const _sent = await sock.sendMessage(replyTo, { text: _reply });
                                if (_sent?.key?.id) botSentIds.add(_sent.key.id);
                                console.log(`🔧 Admin ${_admNum}: ${_admText} → ${_reply}`);
                            } catch (e) { console.error('Admin cmd reply error:', e.message); }
                        }
                        continue;
                    }
                }
            }

            if (!botEnabled) continue;

            // Skip excluded numbers — check both resolved phone and raw JID prefix
            const phoneNum = replyTo.split('@')[0];
            const fromNum = from.split('@')[0];

            // Log ALL arrivals to CRM before exclusion check — for diagnostics
            const rawText = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                msg.message?.documentMessage?.caption ||
                '[media]'
            ).trim();
            upsertCRM(phoneNum, rawText, 'customer');
            console.log(`📩 [${type}] from:${phoneNum} text:"${rawText.substring(0,40)}" excluded:${isExcluded(phoneNum,fromNum)}`);

            if (isExcluded(phoneNum, fromNum)) continue;

            const text = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                msg.message?.documentMessage?.caption ||
                ''
            ).trim();

            // Non-text message (voice note, sticker, image with no caption, etc.)
            // Acknowledge so the customer knows someone is listening
            if (!text) {
                const isVoice = !!(msg.message?.audioMessage || msg.message?.pttMessage);
                const isImage = !!(msg.message?.imageMessage);
                const isVideo = !!(msg.message?.videoMessage);
                let ackText = null;
                if (isVoice) {
                    ackText = 'Halo! Maaf, kami tidak bisa mendengarkan pesan suara secara otomatis 🙏 Bisa tulis pesannya ya? Kami siap membantu!\n\nHi! Sorry, we can\'t process voice messages automatically. Could you type your message? We\'re happy to help!';
                } else if (isImage) {
                    ackText = 'Halo! Terima kasih sudah mengirim gambar 😊 Bisa ceritakan apa yang Anda butuhkan? Misalnya, apakah ini referensi desain untuk order custom?\n\nHi! Thanks for the photo! Could you tell us what you need? For example, is this a design reference for a custom order?';
                } else if (isVideo) {
                    ackText = 'Halo! Terima kasih sudah mengirim video 😊 Bisa jelaskan apa yang Anda butuhkan?\n\nHi! Thanks for the video! Could you describe what you need?';
                }
                if (ackText) {
                    try {
                        const sent = await sock.sendMessage(replyTo, { text: ackText });
                        if (sent?.key?.id) botSentIds.add(sent.key.id);
                        console.log(`📤 non-text ack sent to ${replyTo}`);
                    } catch (e) {
                        console.error('Error sending non-text ack:', e.message);
                    }
                }
                continue;
            }

            console.log(`📩 ${replyTo}: ${text}`);
            upsertCRM(phoneNum, text, 'customer');

            try {
                const { text: reply, handoff } = await getAIReply(replyTo, text);
                // Re-check exclusion after the async AI call — the team may have
                // replied while we were waiting for the AI response.
                if (isExcluded(phoneNum, fromNum)) {
                    console.log(`⚠️ ${phoneNum} excluded while generating reply — discarding`);
                    continue;
                }
                // Always send to @s.whatsapp.net (replyTo).
                // If the message arrived via @lid, remap the quoted key's remoteJid to @s.whatsapp.net
                // so the quoted context doesn't carry an @lid JID (which causes error 463).
                const quotedMsg = from.endsWith('@lid')
                    ? { ...msg, key: { ...msg.key, remoteJid: replyTo } }
                    : msg;
                const sent = await sock.sendMessage(replyTo, { text: reply }, { quoted: quotedMsg });
                console.log(`📤 sent to ${replyTo}, key: ${sent?.key?.id}, status: ${sent?.status}`);
                if (sent?.key?.id) botSentIds.add(sent.key.id);
                console.log(`🤖 Replied to ${replyTo}: ${reply.substring(0, 80)}...\n`);
                upsertCRM(phoneNum, reply, 'tica');

                // Human handoff — permanently exclude so bot stays silent until team re-enables
                if (handoff) {
                    const nums = [...new Set([phoneNum, fromNum])];
                    for (const n of nums) { excludedNumbers.add(n); softExcluded.delete(n); }
                    saveExcluded(excludedNumbers);
                    if (crmData[phoneNum]) { crmData[phoneNum].status = 'needs_cs'; saveCRM(); }
                    console.log(`🤝 Handoff: permanently excluded ${nums.join('/')} — team takes over`);
                }
            } catch (err) {
                console.error('Error replying (with quote):', err.message);
                // Fallback: send without quoted context
                try {
                    const fallback = conversations[replyTo]?.slice(-1)[0]?.content || 'Halo! Terima kasih sudah menghubungi Artistica Jewelry. Kami akan segera membalas.';
                    const sent2 = await sock.sendMessage(replyTo, { text: fallback });
                    console.log(`📤 fallback sent to ${replyTo}, key: ${sent2?.key?.id}, status: ${sent2?.status}`);
                    if (sent2?.key?.id) botSentIds.add(sent2.key.id);
                } catch (err2) {
                    console.error('Error replying (fallback):', err2.message);
                }
            }
        }
    });
}

console.log('🚀 Starting Artistica WhatsApp AI Bot...');
startBot().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
