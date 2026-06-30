/**
 * WhatsApp CRM Gateway
 * =====================
 * WhatsApp Web unofficial gateway using whatsapp-web.js
 * Provides REST API for sending messages, receiving replies,
 * managing customers, and integrating with n8n workflows.
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
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── Config ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/crm.db';
const SESSION_PATH = process.env.SESSION_PATH || './session';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const API_KEY = process.env.API_KEY || '';
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS) || 8000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS) || 20000;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS) || 60000;

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
    // Skip auth for QR and status endpoints
    if (req.path === '/qr' || req.path === '/status') return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key === API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized. Provide X-API-Key header.' });
}

// Apply auth to API routes only (not dashboard or QR page)
app.use('/api', authMiddleware);

// ─── WhatsApp Client ───────────────────────────────────────
let qrCodeData = null;
let whatsappReady = false;
let clientInfo = null;

const whatsapp = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

whatsapp.on('qr', async (qr) => {
    qrCodeData = await QRCode.toDataURL(qr, { width: 300 });
    console.log('[QR] New QR code generated. Scan with WhatsApp.');
    io.emit('qr', qrCodeData);
    io.emit('status', { connected: false, message: 'Scan QR code' });
});

whatsapp.on('ready', () => {
    whatsappReady = true;
    qrCodeData = null;
    clientInfo = whatsapp.info;
    console.log(`[WA] Connected as ${clientInfo.pushname} (${clientInfo.wid.user})`);
    io.emit('ready', { pushname: clientInfo.pushname, phone: clientInfo.wid.user });
    io.emit('status', { connected: true, message: 'Connected', pushname: clientInfo.pushname });
});

whatsapp.on('disconnected', (reason) => {
    whatsappReady = false;
    console.log(`[WA] Disconnected: ${reason}`);
    io.emit('status', { connected: false, message: `Disconnected: ${reason}` });
});

whatsapp.on('auth_failure', (msg) => {
    whatsappReady = false;
    console.error(`[WA] Auth failure: ${msg}`);
    io.emit('status', { connected: false, message: 'Authentication failed. Re-scan QR.' });
});

// ─── Incoming Message Handler ──────────────────────────────
whatsapp.on('message', async (msg) => {
    if (msg.fromMe) return; // Skip own messages
    if (msg.isStatus) return; // Skip status updates

    const phone = msg.from.replace('@c.us', '').replace('@g.us', '');
    const body = msg.body || '';

    console.log(`[MSG] Incoming from +${phone}: ${body.substring(0, 50)}...`);

    // Find or create customer
    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    if (!customer) {
        const cleanPhone = phone.startsWith('0') ? phone.substring(1) : phone;
        const fullPhone = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;
        const insert = db.prepare('INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)');
        insert.run(`Customer_${phone}`, fullPhone);
        customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    }

    if (customer) {
        // Store reply
        db.prepare('INSERT INTO replies (customer_id, message, raw_webhook) VALUES (?, ?, ?)')
            .run(customer.id, body, JSON.stringify({ from: msg.from, timestamp: msg.timestamp }));

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
                    timestamp: new Date().toISOString(),
                    message_id: msg.id._serialized
                })
            }).catch(err => console.error('[WEBHOOK] Failed to forward:', err.message));
        }

        io.emit('new-reply', {
            customer_id: customer.id,
            customer_name: customer.name,
            phone: customer.phone,
            message: body,
            timestamp: new Date().toISOString()
        });
    }
});

// ─── Helper: Send Single Message ───────────────────────────
async function sendWhatsAppMessage(phone, message) {
    // Normalize phone
    let cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
    if (!cleanPhone.endsWith('@c.us')) cleanPhone = `${cleanPhone}@c.us`;

    const sent = await whatsapp.sendMessage(cleanPhone, message);
    return sent;
}

// ─── Helper: Random Delay ──────────────────────────────────
function randomDelay() {
    return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════

// ─── Status ────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({
        whatsapp: whatsappReady,
        client: clientInfo ? { pushname: clientInfo.pushname, phone: clientInfo.wid.user } : null,
        uptime: process.uptime(),
        stats: {
            customers: db.prepare('SELECT COUNT(*) as count FROM customers').get().count,
            messages_sent: db.prepare("SELECT COUNT(*) as count FROM messages WHERE direction='outgoing'").get().count,
            replies: db.prepare('SELECT COUNT(*) as count FROM replies').get().count
        }
    });
});

// ─── QR Code Page ──────────────────────────────────────────
app.get('/api/qr', (req, res) => {
    if (whatsappReady) {
        return res.json({ connected: true, message: 'Already connected' });
    }
    if (qrCodeData) {
        return res.json({ connected: false, qr: qrCodeData });
    }
    res.json({ connected: false, message: 'Waiting for QR code...' });
});

// ─── QR Code HTML Page ─────────────────────────────────────
app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'qr.html'));
});

// ─── Customers CRUD ────────────────────────────────────────
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

// ─── Import Customers from Excel ───────────────────────────
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

                // Normalize phone
                phone = String(phone).replace(/[^0-9+]/g, '');
                if (!phone.startsWith('+')) {
                    if (phone.startsWith('00')) phone = '+' + phone.substring(2);
                    else if (phone.startsWith('0')) phone = '+966' + phone.substring(1);
                    else if (phone.length === 9) phone = '+966' + phone;
                    else phone = '+' + phone;
                }

                try {
                    insert.run(name, phone);
                    imported++;
                } catch (e) {
                    skipped++;
                }
            }
            return { imported, skipped };
        });

        const result = insertMany(data);

        // Cleanup temp file
        fs.unlinkSync(req.file.path);

        res.json({
            total_rows: data.length,
            imported: result.imported,
            skipped: result.skipped,
            message: `Imported ${result.imported} customers, skipped ${result.skipped} (duplicates or invalid)`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Send Message to Single Customer ───────────────────────
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
        }

        // Create message record
        const msgRecord = db.prepare(
            "INSERT INTO messages (customer_id, message, status) VALUES (?, ?, 'sending')"
        ).run(custId || 0, message);

        try {
            await sendWhatsAppMessage(targetPhone, message);
            db.prepare("UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?")
                .run(msgRecord.lastInsertRowid);
            res.json({ success: true, message_id: msgRecord.lastInsertRowid, status: 'sent' });
        } catch (err) {
            db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?")
                .run(err.message, msgRecord.lastInsertRowid);
            res.status(500).json({ success: false, error: err.message, message_id: msgRecord.lastInsertRowid });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Send Campaign ─────────────────────────────────────────
app.post('/api/campaigns', async (req, res) => {
    const { name, message_template, customer_ids } = req.body;
    if (!name || !message_template) return res.status(400).json({ error: 'name and message_template required' });

    // Create campaign
    const campaign = db.prepare('INSERT INTO campaigns (name, message_template) VALUES (?, ?)')
        .run(name, message_template);

    // Get target customers
    let customers;
    if (customer_ids && customer_ids.length > 0) {
        const placeholders = customer_ids.map(() => '?').join(',');
        customers = db.prepare(`SELECT * FROM customers WHERE id IN (${placeholders}) AND status = 'active'`)
            .all(...customer_ids);
    } else {
        customers = db.prepare("SELECT * FROM customers WHERE status = 'active'").all();
    }

    // Link customers to campaign
    const linkStmt = db.prepare('INSERT OR IGNORE INTO campaign_customers (campaign_id, customer_id) VALUES (?, ?)');
    for (const c of customers) {
        linkStmt.run(campaign.lastInsertRowid, c.id);
    }

    // Update campaign count
    db.prepare('UPDATE campaigns SET total_customers = ?, status = ? WHERE id = ?')
        .run(customers.length, 'active', campaign.lastInsertRowid);

    res.json({
        campaign_id: campaign.lastInsertRowid,
        name,
        total_customers: customers.length,
        status: 'active'
    });
});

// ─── Process Campaign (send messages with delays) ──────────
app.post('/api/campaigns/:id/send', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const campaignId = req.params.id;
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Get pending customers for this campaign
    const pending = db.prepare(`
        SELECT cc.*, c.name, c.phone
        FROM campaign_customers cc
        JOIN customers c ON c.id = cc.customer_id
        WHERE cc.campaign_id = ? AND cc.status = 'pending'
    `).all(campaignId);

    if (pending.length === 0) {
        return res.json({ message: 'No pending customers', campaign_id: campaignId });
    }

    // Respond immediately, process in background
    res.json({
        campaign_id: campaignId,
        pending: pending.length,
        message: `Starting to send ${pending.length} messages with random delays`
    });

    // Process in background
    processCampaign(campaignId, campaign.message_template, pending);
});

async function processCampaign(campaignId, template, customers) {
    console.log(`[CAMPAIGN] Starting campaign ${campaignId} with ${customers.length} customers`);

    for (const customer of customers) {
        try {
            // Personalize message
            const personalizedMsg = template.replace(/\{\{Name\}\}/gi, customer.name)
                                            .replace(/\{\{name\}\}/gi, customer.name)
                                            .replace(/\{\{Phone\}\}/gi, customer.phone);

            // Create message record
            const msgRecord = db.prepare(
                "INSERT INTO messages (customer_id, message, direction, status) VALUES (?, ?, 'outgoing', 'sending')"
            ).run(customer.customer_id, personalizedMsg);

            try {
                await sendWhatsAppMessage(customer.phone, personalizedMsg);

                db.prepare("UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .run(msgRecord.lastInsertRowid);
                db.prepare("UPDATE campaign_customers SET status = 'sent', message_id = ? WHERE campaign_id = ? AND customer_id = ?")
                    .run(msgRecord.lastInsertRowid, campaignId, customer.customer_id);
                db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(campaignId);

                console.log(`[SENT] ${customer.name} (${customer.phone})`);
                io.emit('campaign-progress', { campaignId, customer: customer.name, status: 'sent' });

            } catch (err) {
                db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?")
                    .run(err.message, msgRecord.lastInsertRowid);

                // Retry logic
                if (customer.retries < MAX_RETRIES) {
                    db.prepare("UPDATE campaign_customers SET status = 'retry' WHERE campaign_id = ? AND customer_id = ?")
                        .run(campaignId, customer.customer_id);
                    console.log(`[RETRY] ${customer.name} - will retry`);
                } else {
                    db.prepare("UPDATE campaign_customers SET status = 'failed' WHERE campaign_id = ? AND customer_id = ?")
                        .run(campaignId, customer.customer_id);
                    db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId);
                    console.log(`[FAILED] ${customer.name} - max retries reached`);
                }

                io.emit('campaign-progress', { campaignId, customer: customer.name, status: 'failed', error: err.message });
            }

            // Random delay between messages
            const delay = randomDelay();
            console.log(`[DELAY] Waiting ${delay / 1000}s before next message...`);
            await sleep(delay);

        } catch (err) {
            console.error(`[ERROR] Campaign processing error:`, err.message);
        }
    }

    // Mark campaign as completed
    db.prepare("UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(campaignId);
    console.log(`[CAMPAIGN] Campaign ${campaignId} completed`);
    io.emit('campaign-complete', { campaignId });
}

// ─── Retry Failed Messages ─────────────────────────────────
app.post('/api/campaigns/:id/retry', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const campaignId = req.params.id;
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Reset retry customers to pending
    db.prepare("UPDATE campaign_customers SET status = 'pending' WHERE campaign_id = ? AND status = 'retry'")
        .run(campaignId);

    const pending = db.prepare(`
        SELECT cc.*, c.name, c.phone
        FROM campaign_customers cc
        JOIN customers c ON c.id = cc.customer_id
        WHERE cc.campaign_id = ? AND cc.status = 'pending'
    `).all(campaignId);

    res.json({ campaign_id: campaignId, retrying: pending.length });
    processCampaign(campaignId, campaign.message_template, pending);
});

// ─── Campaigns List ────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
    const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    res.json(campaigns);
});

app.get('/api/campaigns/:id', (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const customers = db.prepare(`
        SELECT cc.status as send_status, c.*
        FROM campaign_customers cc
        JOIN customers c ON c.id = cc.customer_id
        WHERE cc.campaign_id = ?
    `).all(req.params.id);

    res.json({ ...campaign, customers });
});

// ─── Messages ──────────────────────────────────────────────
app.get('/api/messages', (req, res) => {
    const { customer_id, status, direction, page = 1, limit = 50 } = req.query;
    let query = 'SELECT m.*, c.name as customer_name, c.phone as customer_phone FROM messages m LEFT JOIN customers c ON c.id = m.customer_id WHERE 1=1';
    const params = [];

    if (customer_id) { query += ' AND m.customer_id = ?'; params.push(customer_id); }
    if (status) { query += ' AND m.status = ?'; params.push(status); }
    if (direction) { query += ' AND m.direction = ?'; params.push(direction); }

    query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const messages = db.prepare(query).all(...params);
    res.json(messages);
});

// ─── Replies ───────────────────────────────────────────────
app.get('/api/replies', (req, res) => {
    const { customer_id, classification, page = 1, limit = 50 } = req.query;
    let query = 'SELECT r.*, c.name as customer_name, c.phone as customer_phone FROM replies r LEFT JOIN customers c ON c.id = r.customer_id WHERE 1=1';
    const params = [];

    if (customer_id) { query += ' AND r.customer_id = ?'; params.push(customer_id); }
    if (classification) { query += ' AND r.classification = ?'; params.push(classification); }

    query += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const replies = db.prepare(query).all(...params);
    res.json(replies);
});

// ─── AI Classification Update (from n8n) ───────────────────
app.post('/api/replies/:id/classify', (req, res) => {
    const { classification, confidence } = req.body;
    if (!classification) return res.status(400).json({ error: 'classification required' });

    const validClasses = ['Interested', 'Not Interested', 'Follow Up', 'Asking Price', 'Other'];
    if (!validClasses.includes(classification)) {
        return res.status(400).json({ error: `Invalid. Must be one of: ${validClasses.join(', ')}` });
    }

    db.prepare('UPDATE replies SET classification = ?, confidence = ? WHERE id = ?')
        .run(classification, confidence || 0, req.params.id);

    // Also update customer's latest classification
    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(req.params.id);
    if (reply) {
        db.prepare('UPDATE customers SET ai_classification = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(classification, reply.customer_id);
    }

    res.json({ success: true });
});

// ─── Dashboard / Stats ─────────────────────────────────────
app.get('/api/stats', (req, res) => {
    const stats = {
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
        no_reply: db.prepare(`
            SELECT COUNT(*) as c FROM customers
            WHERE id NOT IN (SELECT DISTINCT customer_id FROM replies)
            AND id IN (SELECT DISTINCT customer_id FROM messages WHERE direction='outgoing')
        `).get().c
    };

    res.json(stats);
});

// ─── Send Reply via Gateway (for n8n to send responses) ────
app.post('/api/reply', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const { customer_id, message } = req.body;
    if (!customer_id || !message) return res.status(400).json({ error: 'customer_id and message required' });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    try {
        await sendWhatsAppMessage(customer.phone, message);

        db.prepare("INSERT INTO messages (customer_id, message, direction, status, sent_at) VALUES (?, ?, 'outgoing', 'sent', CURRENT_TIMESTAMP)")
            .run(customer_id, message);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Health Check ───────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: whatsappReady, uptime: process.uptime() });
});

// ─── Dashboard Redirect ────────────────────────────────────
app.get('/', (req, res) => {
    res.redirect('/dashboard/');
});

// ─── Socket.IO Connection ──────────────────────────────────
io.on('connection', (socket) => {
    console.log('[IO] Client connected');

    // Send current status
    socket.emit('status', {
        connected: whatsappReady,
        message: whatsappReady ? 'Connected' : (qrCodeData ? 'Scan QR code' : 'Initializing...')
    });

    if (qrCodeData) socket.emit('qr', qrCodeData);
    if (whatsappReady && clientInfo) {
        socket.emit('ready', { pushname: clientInfo.pushname, phone: clientInfo.wid.user });
    }

    socket.on('disconnect', () => console.log('[IO] Client disconnected'));
});

// ─── Initialize WhatsApp ───────────────────────────────────
console.log('[INIT] Initializing WhatsApp client...');
whatsapp.initialize().catch(err => {
    console.error('[INIT] Failed to initialize:', err.message);
});

// ─── Start Server ──────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   WhatsApp CRM Gateway                      ║
║   Running on port ${PORT}                       ║
║   Dashboard: http://localhost:${PORT}/dashboard ║
║   API: http://localhost:${PORT}/api             ║
╚══════════════════════════════════════════════╝
    `);
});

// ─── Graceful Shutdown ─────────────────────────────────────
process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing...');
    await whatsapp.destroy();
    db.close();
    server.close();
    process.exit(0);
});
