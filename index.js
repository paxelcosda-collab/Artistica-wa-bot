require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const QRCode = require('qrcode');
const pino = require('pino');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let botStatus = 'Starting...';
let qrDataUrl = null;
let botEnabled = true;
const conversations = {};

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
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // Track saved contacts — bot only replies to unknown numbers
    const savedContacts = new Map();
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.name) savedContacts.set(c.id, true);
        }
    });
    sock.ev.on('contacts.update', (updates) => {
        for (const u of updates) {
            if (u.id && u.name) savedContacts.set(u.id, true);
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
                console.log('Logged out — clearing session and restarting for fresh QR...');
                const fs = require('fs');
                try { fs.rmSync('./auth_session', { recursive: true, force: true }); } catch (_) {}
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
            if (!from || from.endsWith('@g.us')) continue;

            if (msg.key.fromMe) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                if (text === '!off') { botEnabled = false; console.log('Bot PAUSED'); }
                if (text === '!on')  { botEnabled = true;  console.log('Bot RESUMED'); }
                continue;
            }

            if (!botEnabled) continue;

            // Skip saved contacts — only auto-reply to unknown/new customers
            if (savedContacts.get(from)) continue;

            const text = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                ''
            ).trim();

            if (!text) continue;

            console.log(`📩 ${from}: ${text}`);

            try {
                const reply = await getAIReply(from, text);
                await sock.sendMessage(from, { text: reply }, { quoted: msg });
                console.log(`🤖 Replied: ${reply.substring(0, 80)}...\n`);
            } catch (err) {
                console.error('Error replying:', err.message);
                try {
                    await sock.sendMessage(from, {
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
