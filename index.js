require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const pino = require('pino');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PHONE_NUMBER = (process.env.WA_PHONE_NUMBER || '6281703553530').replace(/\D/g, '');

let botStatus = 'Starting...';
let currentPairingCode = null;
let botEnabled = true;
const conversations = {};

// ── Express dashboard (required by Render to keep service alive) ──────────────
const app = express();

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><title>Artistica Bot</title>
<meta http-equiv="refresh" content="10">
<style>body{font-family:sans-serif;padding:40px;max-width:620px;margin:auto}
.card{background:#f9f9f9;border:1px solid #ddd;border-radius:10px;padding:24px;margin:20px 0}
.code{font-size:36px;font-weight:bold;letter-spacing:6px;color:#1a7f37;margin:10px 0}
.status-ok{color:#1a7f37}.status-wait{color:#e67e00}</style></head>
<body>
<h1>🤖 Artistica WhatsApp AI Bot</h1>
<div class="card">
  <strong>Status:</strong>
  <span class="${botStatus.includes('Connected') ? 'status-ok' : 'status-wait'}">${botStatus}</span>
</div>
${currentPairingCode ? `
<div class="card" style="border-color:#1a7f37;background:#e8f5e9">
  <h2 style="margin:0 0 8px">📱 Enter this code in WhatsApp</h2>
  <div class="code">${currentPairingCode}</div>
  <ol style="margin-top:16px">
    <li>Open WhatsApp on <strong>+${PHONE_NUMBER}</strong></li>
    <li>Tap <strong>⋮ Menu → Linked Devices → Link a Device</strong></li>
    <li>Tap <strong>"Link with phone number instead"</strong></li>
    <li>Enter the code above</li>
  </ol>
</div>` : ''}
<p style="color:#aaa;font-size:12px">Auto-refreshes every 10 seconds</p>
</body></html>`);
});

app.listen(process.env.PORT || 3000, () =>
    console.log(`Dashboard running on port ${process.env.PORT || 3000}`)
);

// ── Artistica system prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the customer service assistant for Artistica Jewelry (Artistica Perhiasan), a 925 sterling silver jewelry manufacturer and wholesaler in Surabaya, Indonesia.

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


// ── WhatsApp bot ───────────────────────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: ['Artistica Bot', 'Chrome', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        // When QR fires it means socket connected — request pairing code instead
        if (qr && !state.creds.registered) {
            botStatus = 'Waiting for pairing code...';
            try {
                await new Promise(r => setTimeout(r, 1500));
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                currentPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                botStatus = 'Waiting for you to enter the pairing code in WhatsApp';
                console.log(`\n📱 PAIRING CODE: ${currentPairingCode}\n`);
                console.log(`Open your Render service URL to see it in a nice page.\n`);
            } catch (err) {
                console.error('Pairing code error:', err.message);
                botStatus = 'Error getting pairing code — check logs';
            }
        }

        if (connection === 'open') {
            currentPairingCode = null;
            botStatus = '✅ Connected — bot is running';
            console.log('✅ WhatsApp connected! Bot is running.\n');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || 'unknown';
            if (code === DisconnectReason.loggedOut) {
                botStatus = '❌ Logged out — restart service';
                console.log('Logged out. Restart the service.');
            } else {
                botStatus = 'Reconnecting...';
                console.log(`Disconnected (code: ${code}, reason: ${msg}), reconnecting in 5s...`);
                setTimeout(() => startBot(), 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.remoteJid.endsWith('@g.us')) continue;

            // Admin toggle from Danny
            if (msg.key.fromMe) {
                if (msg.message?.conversation === '!off') { botEnabled = false; console.log('Bot PAUSED'); }
                if (msg.message?.conversation === '!on')  { botEnabled = true;  console.log('Bot RESUMED'); }
                continue;
            }

            if (!botEnabled) continue;

            const text = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text || ''
            ).trim();

            if (!text) continue;

            const from = msg.key.remoteJid;
            console.log(`📩 ${from}: ${text}`);

            try {
                const reply = await getAIReply(from, text);
                await sock.sendMessage(from, { text: reply }, { quoted: msg });
                console.log(`🤖 Replied: ${reply.substring(0, 80)}...\n`);
            } catch (err) {
                console.error('Error:', err.message);
                await sock.sendMessage(from, {
                    text: 'Halo! Terima kasih sudah menghubungi Artistica Jewelry. Kami akan segera membalas.\n\nHello! Thank you for contacting Artistica Jewelry. We will reply shortly.'
                });
            }
        }
    });
}

console.log('🚀 Starting Artistica WhatsApp AI Bot...');
startBot();
