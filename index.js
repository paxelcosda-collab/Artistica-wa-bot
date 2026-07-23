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

// ── Excluded numbers (team manually replied → bot stays silent) ────────────────
const EXCLUDED_FILE = './auth_session/excluded.json';

function loadExcluded() {
    try { return new Set(JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8'))); } catch (_) { return new Set(); }
}
function saveExcluded(set) {
    try { fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...set])); } catch (_) {}
}

const excludedNumbers = loadExcluded();
console.log(`Loaded ${excludedNumbers.size} excluded numbers`);

// ── Express dashboard ──────────────────────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><title>Artistica Bot</title>
<meta http-equiv="refresh" content="10">
<style>body{font-family:sans-serif;padding:40px;max-width:620px;margin:auto}
.card{background:#f9f9f9;border:1px solid #ddd;border-radius:10px;padding:24px;margin:20px 0}
.status-ok{color:#1a7f37}.status-wait{color:#e67e00}
</style></head>
<body>
<h1>🤖 Artistica WhatsApp AI Bot</h1>
<div class="card">
  <strong>Status:</strong>
  <span class="${botStatus.includes('Connected') ? 'status-ok' : 'status-wait'}">${botStatus}</span>
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
        res.json({ success: true, key: result?.key, status: result?.status });
    } catch (err) {
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

app.listen(process.env.PORT || 3000, () =>
    console.log(`Dashboard running on port ${process.env.PORT || 3000}`)
);

// ── Artistica system prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Your name is Tica. You are the customer service assistant for Artistica Jewelry (Artistica Perhiasan), a 925 sterling silver jewelry manufacturer and wholesaler in Surabaya, Indonesia. Always introduce yourself as Tica when greeting new customers.

## About Artistica
- Founded 2003, factory in Surabaya, East Java, Indonesia
- Website: artisticaindo.com
- WhatsApp: +62 817 0355 3530
- Email: artistica@artisticaindo.com
- Hours: Monday–Saturday, 09:00–17:00 WIB (UTC+7)

## Products & Services
- Ready-made wholesale silver jewelry: rings, necklaces, bracelets, earrings, pendants, brooches
- Custom OEM/ODM: client provides design → CAD → wax prototype → casting → finishing
- Private label: unbranded jewelry with client's packaging/tags
- Jewelry making class: hands-on silversmithing (individuals, groups, corporate)
- Laser engraving: logo, monogram, text on silver jewelry

## Materials & Quality
- 925 sterling silver, hallmarked
- Finishes: natural silver, rhodium, 18K gold plating, rose gold plating, black oxidized
- Nickel-free (EU Directive compliant), REACH compliant, Lead-free, Cadmium-free

## MOQ & Lead Time
- Ready-made wholesale: MOQ 10 pieces per design, 3–7 working days
- Custom OEM/ODM: MOQ 30 pieces per design, 21–30 working days after design approval
- Sample: available for custom designs (sample fee applies, refundable on bulk order)

## Pricing
- NEVER quote specific prices — pricing depends on design, weight, and quantity
- Ask customers to share their design reference or product for a quote

## Shipping & Customs
- Worldwide shipping: air freight (DHL, FedEx) or sea freight
- HS Code: 7113.11 (silver jewelry)
- Australia: 0% duty (IA-CEPA); USA: 5.5%; UK & EU: 2.5%; Singapore/Canada: 0%

## Payment
- 50% deposit upfront, 50% before shipment
- Bank transfer (T/T), L/C for orders above $10,000 USD

## Jewelry Making Class
- Individuals, groups, corporate team building
- Duration 2–4 hours; participants make their own ring or pendant
- Must book in advance — ask for preferred date and group size

## Laser Engraving (Gravir) Pricing
- Price: Rp 10,000 per character (letters, numbers, symbols, logos each count as 1 character)
- When a customer asks about engraving price: count all characters in their text/design and multiply by Rp 10,000
- Example: "Rizal 07.11.26" = 13 characters = Rp 130,000
- Spaces also count as characters

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

## What you CANNOT answer — say "team will check and reply soon"
Never guess on these — always say the team will follow up:
- Order status / "is my order ready?" / "kapan pesanan saya jadi?"
- Specific delivery dates for existing orders
- Payment confirmation / "did you receive my transfer?"
- Design file received confirmation
- Any question about a specific ongoing order

For these reply: "Untuk mengecek status pesanan kamu, tim kami akan konfirmasi segera ya! 🙏" (Indonesian) or "I'll check your order status with our team and get back to you shortly!" (English)

## How to reply
- Warm, friendly, professional — like a helpful sales rep
- SHORT replies — 3–6 lines max, this is WhatsApp not email
- Respond in the SAME LANGUAGE the customer writes
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

    const reply = response.content[0].text.trim();
    conversations[contactId].push({ role: 'assistant', content: reply });
    return reply;
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
        defaultQueryTimeoutMs: 120000,
        connectTimeoutMs: 60000,
    });

    sockRef = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates) {
            if (botSentIds.has(key?.id)) {
                console.log(`📊 Delivery status: ${key.id.substring(0, 8)} → ${update?.status}`);
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
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue;
            // For @lid JIDs (WhatsApp MDv2 privacy), use senderPn for actual delivery
            const replyTo = (from.endsWith('@lid') && msg.key.senderPn) ? msg.key.senderPn : from;

            if (msg.key.fromMe) {
                // Skip messages the bot itself sent — don't treat them as team replies
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
                // Team manually replied to someone → exclude that number from auto-reply
                if (text && !text.startsWith('!')) {
                    const num = from.split('@')[0];
                    if (!excludedNumbers.has(num)) {
                        excludedNumbers.add(num);
                        saveExcluded(excludedNumbers);
                        console.log(`Auto-excluded ${num} (team replied manually)`);
                    }
                }
                continue;
            }

            if (!botEnabled) continue;

            // Skip excluded numbers (team already handling this conversation)
            const phoneNum = replyTo.split('@')[0];
            if (excludedNumbers.has(phoneNum)) continue;

            const text = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                ''
            ).trim();

            if (!text) continue;

            console.log(`📩 ${replyTo}: ${text}`);

            try {
                const reply = await getAIReply(replyTo, text);
                // For @lid JIDs, send back to the @lid (MDv2 native routing).
                // senderPn is used only for excluded-number checks and logging.
                const sendTarget = from.endsWith('@lid') ? from : replyTo;
                const sent = await sock.sendMessage(sendTarget, { text: reply }, { quoted: msg });
                console.log(`📤 sent to ${sendTarget}, key: ${sent?.key?.id}`);
                if (sent?.key?.id) botSentIds.add(sent.key.id);
                console.log(`🤖 Replied to ${replyTo}: ${reply.substring(0, 80)}...\n`);
            } catch (err) {
                console.error('Error replying:', err.message);
                try {
                    await sock.sendMessage(replyTo, {
                        text: 'Halo! Terima kasih sudah menghubungi Artistica Jewelry. Kami akan segera membalas.\n\nHello! Thank you for contacting Artistica Jewelry. We will reply shortly.'
                    });
                } catch (_) {}
            }
        }
    });
}

console.log('🚀 Starting Artistica WhatsApp AI Bot...');
startBot().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
