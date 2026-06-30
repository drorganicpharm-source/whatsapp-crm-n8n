/**
 * WhatsApp CRM Gateway v2
 * Last updated: 2026-06-30 19:45:47
 * ========================
 * Uses Baileys (more reliable than whatsapp-web.js)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Baileys imports
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

// ─── Config ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/crm.db';
const SESSION_PATH = process.env.SESSION_PATH || './auth_session';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const API_KEY = process.env.API_KEY || '';
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS) || 8000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS) || 20000;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;

// ─── Ensure directories ────────────────────────────────────
[path.dirname(DB_PATH), SESSION_PATH, './uploads'].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
});

// ─── Database Setup ────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'active',
        ai_classification TEXT DEFAULT NULL,
        tags TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'outgoing',
        status TEXT DEFAULT 'pending',
        error TEXT DEFAULT NULL,
        retries INTEGER DEFAULT 0,
        sent_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        classification TEXT DEFAULT 'Other',
        confidence REAL DEFAULT 0,
        raw_webhook TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        message_template TEXT NOT NULL,
        total_customers INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        message_id INTEGER DEFAULT NULL,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        UNIQUE(campaign_id, customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_replies_customer ON replies(customer_id);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaign_customers(status);
`);

// ─── Express + Socket.IO ───────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

// ─── API Key Middleware ────────────────────────────────────
function authMiddleware(req, res, next) {
    if (!API_KEY) return next();
    if (req.path === '/qr' || req.path === '/status') return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key === API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized. Provide X-API-Key header.' });
}
app.use('/api', authMiddleware);

// ─── WhatsApp Client (Baileys) ─────────────────────────────
let qrCodeData = null;
let whatsappReady = false;
let sock = null;

const logger = pino({ level: 'silent' });

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        printQRInTerminal: false,
        browser: ['WhatsApp CRM', 'Chrome', '120.0'],
        generateHighQualityLinkPreview: false
    });

    // Handle QR Code
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr, { width: 300 });
            console.log('[QR] New QR code generated. Scan with WhatsApp.');
            io.emit('qr', qrCodeData);
            io.emit('status', { connected: false, message: 'Scan QR code' });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            whatsappReady = false;
            console.log(`[WA] Connection closed. Status: ${statusCode}`);

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('[WA] Reconnecting...');
                setTimeout(connectWhatsApp, 3000);
            } else {
                console.log('[WA] Logged out. Please re-scan QR.');
                io.emit('status', { connected: false, message: 'Logged out. Re-scan QR.' });
            }
        }

        if (connection === 'open') {
            whatsappReady = true;
            qrCodeData = null;
            console.log('[WA] Connected successfully!');
            io.emit('ready', { connected: true });
            io.emit('status', { connected: true, message: 'Connected' });
        }
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const body = msg.message?.conversation ||
                         msg.message?.extendedTextMessage?.text ||
                         msg.message?.imageMessage?.caption ||
                         '';

            if (!body) continue;

            console.log(`[MSG] Incoming from ${phone}: ${body.substring(0, 50)}...`);

            // Find or create customer
            let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(`+${phone}`);
            if (!customer) {
                db.prepare('INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)').run(`Customer_${phone}`, `+${phone}`);
                customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(`+${phone}`);
            }

            if (customer) {
                // Store reply
                db.prepare('INSERT INTO replies (customer_id, message, raw_webhook) VALUES (?, ?, ?)').run(customer.id, body, JSON.stringify(msg));

                // Forward to n8n webhook
                if (N8N_WEBHOOK_URL) {
                    fetch(N8N_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            customer_id: customer.id,
                            customer_name: customer.name,
                            phone: customer.phone,
                            message: body,
                            timestamp: new Date().toISOString()
                        })
                    }).catch(err => console.error('[WEBHOOK] Failed:', err.message));
                }

                io.emit('new-reply', {
                    customer_id: customer.id,
                    customer_name: customer.name,
                    phone: customer.phone,
                    message: body,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
}

// ─── Helper: Send Message ──────────────────────────────────
async function sendWhatsAppMessage(phone, message) {
    if (!whatsappReady || !sock) throw new Error('WhatsApp not connected');

    let cleanPhone = phone.replace(/[^0-9]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;

    // Check if number exists on WhatsApp
    const [exists] = await sock.onWhatsApp(jid);
    if (!exists || !exists.exists) {
        throw new Error(`Phone +${cleanPhone} is not registered on WhatsApp`);
    }

    const sent = await sock.sendMessage(jid, { text: message });
    return sent;
}

// ─── Helper: Delay ─────────────────────────────────────────
function randomDelay() {
    return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
    res.json({
        whatsapp: whatsappReady,
        uptime: process.uptime(),
        stats: {
            customers: db.prepare('SELECT COUNT(*) as count FROM customers').get().count,
            messages_sent: db.prepare("SELECT COUNT(*) as count FROM messages WHERE direction='outgoing'").get().count,
            replies: db.prepare('SELECT COUNT(*) as count FROM replies').get().count
        }
    });
});

app.get('/api/qr', (req, res) => {
    if (whatsappReady) return res.json({ connected: true, message: 'Already connected' });
    if (qrCodeData) return res.json({ connected: false, qr: qrCodeData });
    res.json({ connected: false, message: 'Waiting for QR code...' });
});

// ─── QR HTML Page ──────────────────────────────────────────
app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'qr.html'));
});

// ─── Send Page ─────────────────────────────────────────────
app.get('/send', (req, res) => {
    res.sendFile(path.join(__dirname, 'send.html'));
});

// ─── Customers ─────────────────────────────────────────────
app.get('/api/customers', (req, res) => {
    const { status, classification, search, page = 1, limit = 50 } = req.query;
    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];

    if (status) { query += ' AND status = ?'; params.push(status); }
    if (classification) { query += ' AND ai_classification = ?'; params.push(classification); }
    if (search) { query += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const customers = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
    res.json({ customers, total, page: parseInt(page), limit: parseInt(limit) });
});

app.post('/api/customers', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });

    try {
        const result = db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(name, phone);
        res.json({ id: result.lastInsertRowid, name, phone, status: 'active' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Phone already exists' });
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/customers/:id', (req, res) => {
    const { name, phone, status, ai_classification, tags, notes } = req.body;
    const sets = [];
    const params = [];

    if (name) { sets.push('name = ?'); params.push(name); }
    if (phone) { sets.push('phone = ?'); params.push(phone); }
    if (status) { sets.push('status = ?'); params.push(status); }
    if (ai_classification !== undefined) { sets.push('ai_classification = ?'); params.push(ai_classification); }
    if (tags) { sets.push('tags = ?'); params.push(JSON.stringify(tags)); }
    if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }

    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);

    db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    res.json(customer);
});

// ─── Import Excel ──────────────────────────────────────────
app.post('/api/customers/import', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const workbook = XLSX.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const insert = db.prepare('INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)');
        const insertMany = db.transaction((rows) => {
            let imported = 0, skipped = 0;
            for (const row of rows) {
                const name = row.Name || row.name || row.NAME || row['الاسم'] || '';
                let phone = row.Phone || row.phone || row.PHONE || row['رقم الهاتف'] || row['الهاتف'] || '';

                if (!name || !phone) { skipped++; continue; }

                phone = String(phone).replace(/[^0-9+]/g, '');
                if (!phone.startsWith('+')) {
                    if (phone.startsWith('00')) phone = '+' + phone.substring(2);
                    else if (phone.startsWith('0')) phone = '+966' + phone.substring(1);
                    else if (phone.length === 9) phone = '+966' + phone;
                    else phone = '+' + phone;
                }

                try { insert.run(name, phone); imported++; } catch (e) { skipped++; }
            }
            return { imported, skipped };
        });

        const result = insertMany(data);
        fs.unlinkSync(req.file.path);

        res.json({
            total_rows: data.length,
            imported: result.imported,
            skipped: result.skipped,
            message: `Imported ${result.imported} customers, skipped ${result.skipped}`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Send Message ──────────────────────────────────────────
app.post('/api/send-message', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const { customer_id, phone, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    try {
        let targetPhone = phone;
        let custId = customer_id;

        if (custId) {
            const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
            if (!customer) return res.status(404).json({ error: 'Customer not found' });
            targetPhone = customer.phone;
        } else if (targetPhone) {
            // Find or create customer by phone
            let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(targetPhone);
            if (!customer) {
                const insert = db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(`Customer`, targetPhone);
                custId = insert.lastInsertRowid;
            } else {
                custId = customer.id;
            }
        }

        if (!targetPhone) return res.status(400).json({ error: 'phone or customer_id required' });

        const msgRecord = db.prepare("INSERT INTO messages (customer_id, message, status) VALUES (?, ?, 'sending')").run(custId || 0, message);

        try {
            await sendWhatsAppMessage(targetPhone, message);
            db.prepare("UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(msgRecord.lastInsertRowid);
            res.json({ success: true, message_id: msgRecord.lastInsertRowid, status: 'sent' });
        } catch (err) {
            db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(err.message, msgRecord.lastInsertRowid);
            res.status(500).json({ success: false, error: err.message, message_id: msgRecord.lastInsertRowid });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Campaigns ─────────────────────────────────────────────
app.post('/api/campaigns', (req, res) => {
    const { name, message_template, customer_ids } = req.body;
    if (!name || !message_template) return res.status(400).json({ error: 'name and message_template required' });

    const campaign = db.prepare('INSERT INTO campaigns (name, message_template) VALUES (?, ?)').run(name, message_template);

    let customers;
    if (customer_ids && customer_ids.length > 0) {
        const placeholders = customer_ids.map(() => '?').join(',');
        customers = db.prepare(`SELECT * FROM customers WHERE id IN (${placeholders}) AND status = 'active'`).all(...customer_ids);
    } else {
        customers = db.prepare("SELECT * FROM customers WHERE status = 'active'").all();
    }

    const linkStmt = db.prepare('INSERT OR IGNORE INTO campaign_customers (campaign_id, customer_id) VALUES (?, ?)');
    for (const c of customers) linkStmt.run(campaign.lastInsertRowid, c.id);

    db.prepare('UPDATE campaigns SET total_customers = ?, status = ? WHERE id = ?').run(customers.length, 'active', campaign.lastInsertRowid);

    res.json({ campaign_id: campaign.lastInsertRowid, name, total_customers: customers.length, status: 'active' });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const campaignId = req.params.id;
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pending = db.prepare(`
        SELECT cc.*, c.name, c.phone
        FROM campaign_customers cc
        JOIN customers c ON c.id = cc.customer_id
        WHERE cc.campaign_id = ? AND cc.status = 'pending'
    `).all(campaignId);

    if (pending.length === 0) return res.json({ message: 'No pending customers', campaign_id: campaignId });

    res.json({ campaign_id: campaignId, pending: pending.length, message: `Sending ${pending.length} messages` });

    processCampaign(campaignId, campaign.message_template, pending);
});

async function processCampaign(campaignId, template, customers) {
    console.log(`[CAMPAIGN] Starting campaign ${campaignId} with ${customers.length} customers`);

    for (const customer of customers) {
        try {
            const personalizedMsg = template.replace(/\{\{Name\}\}/gi, customer.name).replace(/\{\{Phone\}\}/gi, customer.phone);

            const msgRecord = db.prepare("INSERT INTO messages (customer_id, message, direction, status) VALUES (?, ?, 'outgoing', 'sending')").run(customer.customer_id, personalizedMsg);

            try {
                await sendWhatsAppMessage(customer.phone, personalizedMsg);
                db.prepare("UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(msgRecord.lastInsertRowid);
                db.prepare("UPDATE campaign_customers SET status = 'sent', message_id = ? WHERE campaign_id = ? AND customer_id = ?").run(msgRecord.lastInsertRowid, campaignId, customer.customer_id);
                db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(campaignId);
                console.log(`[SENT] ${customer.name}`);
                io.emit('campaign-progress', { campaignId, customer: customer.name, status: 'sent' });
            } catch (err) {
                db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(err.message, msgRecord.lastInsertRowid);
                db.prepare("UPDATE campaign_customers SET status = 'failed' WHERE campaign_id = ? AND customer_id = ?").run(campaignId, customer.customer_id);
                db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId);
                console.log(`[FAILED] ${customer.name}: ${err.message}`);
                io.emit('campaign-progress', { campaignId, customer: customer.name, status: 'failed', error: err.message });
            }

            const delay = randomDelay();
            console.log(`[DELAY] Waiting ${delay / 1000}s...`);
            await sleep(delay);
        } catch (err) {
            console.error(`[ERROR]`, err.message);
        }
    }

    db.prepare("UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);
    console.log(`[CAMPAIGN] Campaign ${campaignId} completed`);
    io.emit('campaign-complete', { campaignId });
}

app.get('/api/campaigns', (req, res) => {
    res.json(db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all());
});

app.get('/api/campaigns/:id', (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const customers = db.prepare(`SELECT cc.status as send_status, c.* FROM campaign_customers cc JOIN customers c ON c.id = cc.customer_id WHERE cc.campaign_id = ?`).all(req.params.id);
    res.json({ ...campaign, customers });
});

// ─── Messages & Replies ────────────────────────────────────
app.get('/api/messages', (req, res) => {
    const { customer_id, status, direction, page = 1, limit = 50 } = req.query;
    let query = 'SELECT m.*, c.name as customer_name, c.phone as customer_phone FROM messages m LEFT JOIN customers c ON c.id = m.customer_id WHERE 1=1';
    const params = [];
    if (customer_id) { query += ' AND m.customer_id = ?'; params.push(customer_id); }
    if (status) { query += ' AND m.status = ?'; params.push(status); }
    if (direction) { query += ' AND m.direction = ?'; params.push(direction); }
    query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    res.json(db.prepare(query).all(...params));
});

app.get('/api/replies', (req, res) => {
    const { customer_id, classification, page = 1, limit = 50 } = req.query;
    let query = 'SELECT r.*, c.name as customer_name, c.phone as customer_phone FROM replies r LEFT JOIN customers c ON c.id = r.customer_id WHERE 1=1';
    const params = [];
    if (customer_id) { query += ' AND r.customer_id = ?'; params.push(customer_id); }
    if (classification) { query += ' AND r.classification = ?'; params.push(classification); }
    query += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    res.json(db.prepare(query).all(...params));
});

app.post('/api/replies/:id/classify', (req, res) => {
    const { classification, confidence } = req.body;
    if (!classification) return res.status(400).json({ error: 'classification required' });
    db.prepare('UPDATE replies SET classification = ?, confidence = ? WHERE id = ?').run(classification, confidence || 0, req.params.id);
    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(req.params.id);
    if (reply) db.prepare('UPDATE customers SET ai_classification = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(classification, reply.customer_id);
    res.json({ success: true });
});

app.post('/api/reply', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });
    const { customer_id, message } = req.body;
    if (!customer_id || !message) return res.status(400).json({ error: 'customer_id and message required' });
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    try {
        await sendWhatsAppMessage(customer.phone, message);
        db.prepare("INSERT INTO messages (customer_id, message, direction, status, sent_at) VALUES (?, ?, 'outgoing', 'sent', CURRENT_TIMESTAMP)").run(customer_id, message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Stats ─────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
    res.json({
        customers: {
            total: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
            active: db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='active'").get().c,
            classified: {
                interested: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Interested'").get().c,
                not_interested: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Not Interested'").get().c,
                follow_up: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Follow Up'").get().c,
                asking_price: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Asking Price'").get().c,
                other: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Other'").get().c,
                unclassified: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification IS NULL").get().c
            }
        },
        messages: {
            total: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
            sent: db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='sent'").get().c,
            failed: db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='failed'").get().c,
            pending: db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='pending'").get().c
        },
        replies: {
            total: db.prepare('SELECT COUNT(*) as c FROM replies').get().c,
            by_class: {
                Interested: db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Interested'").get().c,
                'Not Interested': db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Not Interested'").get().c,
                'Follow Up': db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Follow Up'").get().c,
                'Asking Price': db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Asking Price'").get().c,
                Other: db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Other'").get().c
            }
        },
        campaigns: {
            total: db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c,
            active: db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status='active'").get().c,
            completed: db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status='completed'").get().c
        },
        no_reply: db.prepare(`SELECT COUNT(*) as c FROM customers WHERE id NOT IN (SELECT DISTINCT customer_id FROM replies) AND id IN (SELECT DISTINCT customer_id FROM messages WHERE direction='outgoing')`).get().c
    });
});

// ─── Health & Dashboard ────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: whatsappReady, uptime: process.uptime() }));
app.get('/', (req, res) => res.redirect('/dashboard/'));

// ─── Socket.IO ─────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('[IO] Client connected');
    socket.emit('status', { connected: whatsappReady, message: whatsappReady ? 'Connected' : 'Initializing...' });
    if (qrCodeData) socket.emit('qr', qrCodeData);
    if (whatsappReady) socket.emit('ready', { connected: true });
    socket.on('disconnect', () => console.log('[IO] Client disconnected'));
});

// ─── Start ─────────────────────────────────────────────────
console.log('[INIT] Initializing WhatsApp client with Baileys...');
connectWhatsApp().catch(err => console.error('[INIT] Failed:', err.message));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   WhatsApp CRM Gateway v2 (Baileys)          ║
║   Port: ${PORT}                                  ║
║   Dashboard: http://localhost:${PORT}/dashboard ║
╚══════════════════════════════════════════════╝
    `);
});

process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing...');
    if (sock) sock.end();
    db.close();
    server.close();
    process.exit(0);
});
