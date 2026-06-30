/**
 * WhatsApp CRM Gateway
 * - Uses Baileys (unofficial WhatsApp Web) for QR login, sending & receiving messages
 * - Exposes a small REST API that n8n can call
 * - Forwards every incoming message to an n8n webhook (N8N_INCOMING_WEBHOOK_URL)
 *
 * Endpoints:
 *   GET  /health                -> liveness check
 *   GET  /qr                    -> returns current QR code as PNG (scan with WhatsApp app)
 *   GET  /status                -> connection state (connected / qr / closed)
 *   POST /send                  -> { phone, message }  -> sends a WhatsApp text message
 *   POST /send-bulk-check       -> { phone } -> checks if a number is registered on WhatsApp
 *
 * All write endpoints require header:  x-api-key: <GATEWAY_API_KEY>
 */

require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode');
const axios = require('axios');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GATEWAY_API_KEY || 'change-me';
const N8N_INCOMING_WEBHOOK_URL = process.env.N8N_INCOMING_WEBHOOK_URL || '';
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let currentQR = null;
let connectionState = 'disconnected'; // disconnected | qr | connecting | connected

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp CRM Gateway', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      connectionState = 'qr';
      logger.info('New QR code generated - call GET /qr to scan it');
    }

    if (connection === 'open') {
      connectionState = 'connected';
      currentQR = null;
      logger.info('WhatsApp connected successfully');
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode }, 'Connection closed');

      if (shouldReconnect) {
        setTimeout(() => startSock(), 3000);
      } else {
        logger.error('Logged out. Delete AUTH_DIR and restart to re-scan QR.');
      }
    }
  });

  // Forward incoming messages to n8n
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid; // e.g. 966500000000@s.whatsapp.net
      const phone = remoteJid?.replace('@s.whatsapp.net', '');
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!phone || remoteJid?.includes('@g.us')) continue; // skip groups

      const payload = {
        phone: `+${phone}`,
        message: text,
        timestamp: Number(msg.messageTimestamp) || Date.now() / 1000,
        raw_id: msg.key.id,
      };

      logger.info({ payload }, 'Incoming WhatsApp message');

      if (N8N_INCOMING_WEBHOOK_URL) {
        try {
          await axios.post(N8N_INCOMING_WEBHOOK_URL, payload, { timeout: 10000 });
        } catch (err) {
          logger.error({ err: err.message }, 'Failed to forward message to n8n webhook');
        }
      }
    }
  });
}

startSock().catch((err) => logger.error(err, 'Failed to start WhatsApp socket'));

// ---------------- REST API ----------------

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing x-api-key header' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, status: connectionState });
});

app.get('/status', (req, res) => {
  res.json({ ok: true, status: connectionState });
});

app.get('/qr', async (req, res) => {
  if (connectionState === 'connected') {
    return res.status(200).json({ ok: true, message: 'Already connected, no QR needed.' });
  }
  if (!currentQR) {
    return res.status(202).json({ ok: false, message: 'QR not generated yet, retry in a few seconds.' });
  }
  const png = await qrcode.toBuffer(currentQR, { type: 'png', width: 320 });
  res.set('Content-Type', 'image/png');
  res.send(png);
});

// normalize phone to E.164 -> jid
function phoneToJid(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

app.post('/send', requireApiKey, async (req, res) => {
  const { phone, message } = req.body || {};

  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'phone and message are required' });
  }
  if (connectionState !== 'connected') {
    return res.status(503).json({ ok: false, error: `WhatsApp not connected (state: ${connectionState})` });
  }

  try {
    const jid = phoneToJid(phone);

    // verify number exists on WhatsApp
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
      return res.status(404).json({ ok: false, error: 'Phone number not registered on WhatsApp' });
    }

    const sent = await sock.sendMessage(result.jid, { text: message });
    return res.json({ ok: true, id: sent.key.id, phone, status: 'sent' });
  } catch (err) {
    logger.error({ err: err.message }, 'Send failed');
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/check-number', requireApiKey, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  try {
    const jid = phoneToJid(phone);
    const [result] = await sock.onWhatsApp(jid);
    res.json({ ok: true, exists: !!result?.exists, jid: result?.jid || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`WhatsApp Gateway listening on port ${PORT}`);
});
