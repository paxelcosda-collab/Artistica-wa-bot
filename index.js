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
- Ready-made wholesale: NEVER mention minimum order or lead time — just ask what design they're interested in and let the team handle the details
- Custom OEM/ODM personal (1 piece): we accept single-piece custom orders — do NOT mention 30 pcs MOQ for personal custom orders
- Custom OEM/ODM wholesale price: MOQ 30 pieces per design — only mention this if they explicitly ask about wholesale pricing or bulk production
- Lead time custom: 21–30 working days after design approval
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

## Jewelry Making Class (Silver Course)
When a customer asks about the jewelry making class / silver course, collect information IN THIS ORDER — ask ONE question at a time, wait for their answer before asking the next:

**Step 1 — Date:** "Rencananya kapan mau ikut kelas peraknya?" / "When are you planning to join the silver course?"
**Step 2 — Number of people:** "Untuk berapa orang?" / "How many people will be joining?"
**Step 3 — Course package:** "Paket kelas yang diminati yang mana?" / "Which course package are you interested in?" (share package options if they don't know)
**Step 4 — What to make:** "Ingin membuat apa? Cincin, anting, liontin, atau yang lain?" / "What would you like to make? Ring, earring, pendant, or something else?"
**Step 5 — Design:**
- If they have chosen what to make: "Sudah punya referensi atau desain yang diinginkan?" / "Do you already have a design reference?"
  - If YES: "Boleh share desainnya ya 😊" / "Please send us the design 😊"
  - If NO: "Tidak apa-apa, tim kami akan kirimkan pilihan desainnya 😊" / "No problem, our team will send you design options 😊"
**Step 6 — Close:** "Terima kasih! Tim kami akan segera menghubungi Anda untuk konfirmasi lebih lanjut 😊" / "Thank you! Our team will contact you shortly to confirm the details 😊"

Do NOT jump ahead — collect each answer before moving to the next step.

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

## Advertisers / Spam / Offers
If a message is clearly someone advertising or offering their own product or service (e.g. "kami menawarkan jasa...", "kami jual...", "kami punya produk...", "we offer our services..."):
- Do NOT engage further with their offer
- Reply politely: "Terima kasih atas tawarannya, jika kami membutuhkan produk/jasa tersebut, kami akan menghubungi Anda kembali 😊" / "Thank you for your offer! If we need that product or service, we will contact you again 😊"
- Do not ask follow-up questions — end the conversation politely there.

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
            // Team manually replied → exclude. Store both the resolved phone AND the
            // raw JID prefix so @lid vs @s.whatsapp.net mismatches are both covered.
            if (text && !text.startsWith('!')) {
                const nums = [...new Set([replyTo.split('@')[0], from.split('@')[0]])];
                let saved = false;
                for (const num of nums) {
                    if (!excludedNumbers.has(num)) {
                        excludedNumbers.add(num);
                        saved = true;
                    }
                }
                if (saved) {
                    saveExcluded(excludedNumbers);
                    console.log(`Auto-excluded ${nums.join('/')} (team replied manually)`);
                }
            }
        }

        // PASS 2: handle incoming customer messages. Only process real-time events.
        if (type !== 'notify') return;

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
            const replyTo = (from.endsWith('@lid') && msg.key.senderPn) ? msg.key.senderPn : from;

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
            if (excludedNumbers.has(phoneNum) || excludedNumbers.has(fromNum)) continue;

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
                // Re-check exclusion after the async AI call — the team may have
                // replied while we were waiting for the AI response.
                if (excludedNumbers.has(phoneNum) || excludedNumbers.has(fromNum)) {
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
