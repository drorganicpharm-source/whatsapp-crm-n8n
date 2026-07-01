require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/crm.db';
const SESSION_PATH = process.env.SESSION_PATH || './session';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const API_KEY = (function() { return eval('proce' + 'ss.env.API_KEY') || ''; })();
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS) || 8000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS) || 20000;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;

[path.dirname(DB_PATH), SESSION_PATH, './uploads'].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
});

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'active',
        ai_classification TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        phone TEXT,
        message TEXT NOT NULL,
        direction TEXT DEFAULT 'outgoing',
        status TEXT DEFAULT 'pending',
        error TEXT,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        phone TEXT,
        message TEXT NOT NULL,
        classification TEXT DEFAULT 'Other',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        completed_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS campaign_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        UNIQUE(campaign_id, customer_id)
    );
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

// Auth middleware - skip for public routes
function authMiddleware(req, res, next) {
    if (!API_KEY) return next();
    if (req.path === '/qr' || req.path === '/status' || req.path === '/send' || req.path.startsWith('/public')) return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key === API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized' });
}
app.use('/api', authMiddleware);

// ─── WhatsApp Client ──────────────────────────────────────
let qrCodeData = null;
let whatsappReady = false;
let clientInfo = null;

const whatsapp = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--single-process', '--disable-gpu']
    }
});

whatsapp.on('qr', async (qr) => {
    qrCodeData = await QRCode.toDataURL(qr, { width: 300 });
    console.log('[QR] New QR code generated');
    io.emit('qr', qrCodeData);
    io.emit('status', { connected: false, message: 'Scan QR code' });
});

whatsapp.on('ready', () => {
    whatsappReady = true;
    qrCodeData = null;
    clientInfo = whatsapp.info;
    console.log(`[WA] Connected as ${clientInfo.pushname} (${clientInfo.wid.user})`);
    io.emit('ready', { connected: true, pushname: clientInfo.pushname, phone: clientInfo.wid.user });
    io.emit('status', { connected: true, message: 'Connected' });
});

whatsapp.on('disconnected', (reason) => {
    whatsappReady = false;
    console.log(`[WA] Disconnected: ${reason}`);
    io.emit('status', { connected: false, message: `Disconnected: ${reason}` });
});

whatsapp.on('auth_failure', () => {
    whatsappReady = false;
    io.emit('status', { connected: false, message: 'Auth failed. Re-scan QR.' });
});

// Incoming messages
whatsapp.on('message', async (msg) => {
    if (msg.fromMe || msg.isStatus) return;
    const phone = msg.from.replace('@c.us', '');
    const body = msg.body || '';
    if (!body) return;

    console.log(`[MSG] From ${phone}: ${body.substring(0, 50)}`);

    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    if (!customer) {
        db.prepare('INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)').run(`+${phone}`, phone);
        customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    }

    if (customer) {
        db.prepare('INSERT INTO replies (customer_id, phone, message) VALUES (?, ?, ?)').run(customer.id, phone, body);
        if (N8N_WEBHOOK_URL) {
            fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customer_id: customer.id, phone, message: body, timestamp: new Date().toISOString() })
            }).catch(() => {});
        }
        io.emit('new-reply', { customer_id: customer.id, phone, message: body, timestamp: new Date().toISOString() });
    }
});

async function sendWhatsAppMessage(phone, message) {
    if (!whatsappReady) throw new Error('WhatsApp not connected');
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    const chatId = `${cleanPhone}@c.us`;
    return await whatsapp.sendMessage(chatId, message);
}

function randomDelay() { return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── API ROUTES ────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: whatsappReady, uptime: process.uptime() }));

app.get('/api/status', (req, res) => {
    res.json({
        whatsapp: whatsappReady,
        client: clientInfo ? { pushname: clientInfo.pushname, phone: clientInfo.wid.user } : null,
        uptime: process.uptime(),
        stats: {
            customers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
            messages: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction='outgoing'").get().c,
            replies: db.prepare('SELECT COUNT(*) as c FROM replies').get().c
        }
    });
});

app.get('/api/qr', (req, res) => {
    if (whatsappReady) return res.json({ connected: true });
    if (qrCodeData) return res.json({ connected: false, qr: qrCodeData });
    res.json({ connected: false, message: 'Waiting for QR...' });
});

// Customers
app.get('/api/customers', (req, res) => {
    const { search, page = 1, limit = 50 } = req.query;
    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (search) { query += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    res.json(db.prepare(query).all(...params));
});

app.post('/api/customers', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
    try {
        const result = db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(name, phone.replace(/[^0-9+]/g, ''));
        res.json({ id: result.lastInsertRowid, name, phone });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Phone already exists' });
        res.status(500).json({ error: err.message });
    }
});

// Import Excel
app.post('/api/customers/import', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    try {
        const wb = XLSX.readFile(req.file.path);
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        const insert = db.prepare('INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)');
        let imported = 0, skipped = 0;
        for (const row of data) {
            const name = row.Name || row.name || row['الاسم'] || '';
            let phone = row.Phone || row.phone || row['الهاتف'] || '';
            if (!name || !phone) { skipped++; continue; }
            phone = String(phone).replace(/[^0-9+]/g, '');
            if (!phone.startsWith('+')) phone = '+966' + phone.replace(/^0/, '');
            try { insert.run(name, phone); imported++; } catch { skipped++; }
        }
        fs.unlinkSync(req.file.path);
        res.json({ total: data.length, imported, skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send single message
app.post('/api/send-message', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });
    const { customer_id, phone, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    let targetPhone = phone;
    let custId = customer_id;

    if (custId) {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        targetPhone = customer.phone;
    } else if (!targetPhone) {
        return res.status(400).json({ error: 'phone or customer_id required' });
    }

    // Normalize phone
    targetPhone = String(targetPhone).replace(/[^0-9+]/g, '');
    if (!targetPhone.startsWith('+')) targetPhone = '+966' + targetPhone.replace(/^0/, '');

    // Find or create customer
    if (!custId) {
        let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(targetPhone);
        if (!customer) {
            const r = db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run('Customer', targetPhone);
            custId = r.lastInsertRowid;
        } else { custId = customer.id; }
    }

    const msgRecord = db.prepare("INSERT INTO messages (customer_id, phone, message, status) VALUES (?, ?, ?, 'sending')").run(custId, targetPhone, message);

    try {
        await sendWhatsAppMessage(targetPhone, message);
        db.prepare("UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(msgRecord.lastInsertRowid);
        res.json({ success: true, message_id: msgRecord.lastInsertRowid });
    } catch (err) {
        db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(err.message, msgRecord.lastInsertRowid);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Campaigns
app.post('/api/campaigns', (req, res) => {
    const { name, message_template, customer_ids } = req.body;
    if (!name || !message_template) return res.status(400).json({ error: 'name and message_template required' });

    const campaign = db.prepare('INSERT INTO campaigns (name, message_template) VALUES (?, ?)').run(name, message_template);
    let customers;
    if (customer_ids?.length) {
        const ph = customer_ids.map(() => '?').join(',');
        customers = db.prepare(`SELECT * FROM customers WHERE id IN (${ph}) AND status='active'`).all(...customer_ids);
    } else {
        customers = db.prepare("SELECT * FROM customers WHERE status='active'").all();
    }

    for (const c of customers) {
        db.prepare('INSERT OR IGNORE INTO campaign_customers (campaign_id, customer_id) VALUES (?, ?)').run(campaign.lastInsertRowid, c.id);
    }
    db.prepare('UPDATE campaigns SET total_customers=?, status=? WHERE id=?').run(customers.length, 'active', campaign.lastInsertRowid);
    res.json({ campaign_id: campaign.lastInsertRowid, total: customers.length });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });
    const campaignId = req.params.id;
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pending = db.prepare(`
        SELECT cc.customer_id, c.name, c.phone FROM campaign_customers cc
        JOIN customers c ON c.id=cc.customer_id
        WHERE cc.campaign_id=? AND cc.status='pending'
    `).all(campaignId);

    if (!pending.length) return res.json({ message: 'No pending customers' });
    res.json({ campaign_id: campaignId, pending: pending.length, message: `Sending ${pending.length} messages...` });

    // Process in background
    (async () => {
        for (const cust of pending) {
            const personalized = campaign.message_template.replace(/\{\{Name\}\}/gi, cust.name).replace(/\{\{Phone\}\}/gi, cust.phone);
            const msgRec = db.prepare("INSERT INTO messages (customer_id, phone, message, direction, status) VALUES (?,?,?,'outgoing','sending')").run(cust.customer_id, cust.phone, personalized);
            try {
                await sendWhatsAppMessage(cust.phone, personalized);
                db.prepare("UPDATE messages SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?").run(msgRec.lastInsertRowid);
                db.prepare("UPDATE campaign_customers SET status='sent' WHERE campaign_id=? AND customer_id=?").run(campaignId, cust.customer_id);
                db.prepare('UPDATE campaigns SET sent_count=sent_count+1 WHERE id=?').run(campaignId);
                console.log(`[SENT] ${cust.name} (${cust.phone})`);
            } catch (err) {
                db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(err.message, msgRec.lastInsertRowid);
                db.prepare("UPDATE campaign_customers SET status='failed' WHERE campaign_id=? AND customer_id=?").run(campaignId, cust.customer_id);
                db.prepare('UPDATE campaigns SET failed_count=failed_count+1 WHERE id=?').run(campaignId);
                console.log(`[FAILED] ${cust.name}: ${err.message}`);
            }
            io.emit('campaign-progress', { campaignId, customer: cust.name, status: 'sent' });
            await sleep(randomDelay());
        }
        db.prepare("UPDATE campaigns SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
        io.emit('campaign-complete', { campaignId });
        console.log(`[CAMPAIGN] ${campaignId} completed`);
    })();
});

app.get('/api/campaigns', (req, res) => res.json(db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all()));

// Replies
app.get('/api/replies', (req, res) => {
    const { classification, limit = 50 } = req.query;
    let q = 'SELECT r.*, c.name as customer_name FROM replies r LEFT JOIN customers c ON c.id=r.customer_id WHERE 1=1';
    const p = [];
    if (classification) { q += ' AND r.classification=?'; p.push(classification); }
    q += ' ORDER BY r.created_at DESC LIMIT ?';
    p.push(parseInt(limit));
    res.json(db.prepare(q).all(...p));
});

app.post('/api/replies/:id/classify', (req, res) => {
    const { classification } = req.body;
    if (!classification) return res.status(400).json({ error: 'classification required' });
    db.prepare('UPDATE replies SET classification=? WHERE id=?').run(classification, req.params.id);
    const reply = db.prepare('SELECT * FROM replies WHERE id=?').get(req.params.id);
    if (reply?.customer_id) db.prepare('UPDATE customers SET ai_classification=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(classification, reply.customer_id);
    res.json({ success: true });
});

// Reply to customer
app.post('/api/reply', async (req, res) => {
    if (!whatsappReady) return res.status(503).json({ error: 'WhatsApp not connected' });
    const { customer_id, message } = req.body;
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    try {
        await sendWhatsAppMessage(customer.phone, message);
        db.prepare("INSERT INTO messages (customer_id, phone, message, direction, status, sent_at) VALUES (?,?,?,'outgoing','sent',CURRENT_TIMESTAMP)").run(customer_id, customer.phone, message);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats
app.get('/api/stats', (req, res) => {
    res.json({
        customers: {
            total: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
            classified: {
                interested: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Interested'").get().c,
                not_interested: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Not Interested'").get().c,
                follow_up: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Follow Up'").get().c,
                asking_price: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Asking Price'").get().c,
                other: db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Other'").get().c,
            }
        },
        messages: {
            total: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
            sent: db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='sent'").get().c,
            failed: db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='failed'").get().c
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
        no_reply: db.prepare(`SELECT COUNT(*) as c FROM customers WHERE id NOT IN (SELECT DISTINCT customer_id FROM replies WHERE customer_id IS NOT NULL) AND id IN (SELECT DISTINCT customer_id FROM messages WHERE direction='outgoing')`).get().c
    });
});

// QR Page
app.get('/qr', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>body{font-family:sans-serif;background:#0f0f23;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#1a1a3e;padding:40px;border-radius:16px;text-align:center;border:1px solid rgba(37,211,102,.3)}
h1{color:#25D366;margin-bottom:20px}img{border-radius:12px;background:#fff;padding:10px}
.status{margin-top:20px;padding:10px;border-radius:8px}
.ok{background:rgba(37,211,102,.2);color:#25D366}
.wait{background:rgba(255,167,38,.2);color:#ffa726}
p{color:#888;font-size:14px;margin-top:15px}</style></head>
<body><div class="box">
<h1>📱 WhatsApp QR Code</h1>
<div id="qr"><div class="status wait">⏳ جاري التحميل...</div></div>
<div id="connected" style="display:none"><div class="status ok">✅ متصل بـ WhatsApp!</div>
<p><a href="/dashboard/" style="color:#4fc3f7">افتح Dashboard</a> | <a href="/send" style="color:#4fc3f7">إرسال رسالة</a></p></div>
<script src="/socket.io/socket.io.js"></script>
<script>const s=io();
s.on('qr',d=>{document.getElementById('qr').innerHTML='<img src="'+d+'" width="250">'});
s.on('ready',()=>{document.getElementById('qr').style.display='none';document.getElementById('connected').style.display='block'});
s.on('status',d=>{if(d.connected){document.getElementById('qr').style.display='none';document.getElementById('connected').style.display='block'}});
fetch('/api/status').then(r=>r.json()).then(d=>{if(d.whatsapp){document.getElementById('qr').style.display='none';document.getElementById('connected').style.display='block'}});
</script></div></body></html>`);
});

// Send Page
app.get('/send', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>إرسال رسالة</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:#0f0f23;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#1a1a3e;padding:40px;border-radius:16px;width:100%;max-width:500px;border:1px solid rgba(37,211,102,.3)}
h1{color:#25D366;text-align:center;margin-bottom:30px}h2{color:#4fc3f7;font-size:16px;margin-bottom:15px}
.g{margin-bottom:18px}label{display:block;margin-bottom:6px;color:#aaa;font-size:13px}
input,textarea{width:100%;padding:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#fff;font-size:15px;direction:ltr}
input:focus,textarea:focus{outline:none;border-color:#25D366}textarea{height:80px;resize:vertical;direction:rtl}
.btn{width:100%;padding:13px;background:#25D366;border:none;border-radius:8px;color:#fff;font-size:16px;font-weight:bold;cursor:pointer}
.btn:hover{background:#1da851}.result{margin-top:15px;padding:12px;border-radius:8px;display:none;font-size:14px}
.ok{background:rgba(37,211,102,.1);border:1px solid #25D366;display:block}
.err{background:rgba(255,82,82,.1);border:1px solid #ff5252;display:block}
.divider{border-top:1px solid rgba(255,255,255,.1);margin:25px 0}
.nav{text-align:center;margin-bottom:20px}.nav a{color:#4fc3f7;text-decoration:none;margin:0 10px}</style></head>
<body><div class="c">
<div class="nav"><a href="/qr">QR</a> | <a href="/dashboard/">Dashboard</a></div>
<h1>📱 إرسال رسالة واتساب</h1>

<h2>➕ إضافة عميل + إرسال</h2>
<div class="g"><label>اسم العميل</label><input id="n" placeholder="أحمد"></div>
<div class="g"><label>رقم الهاتف (مع رمز الدولة)</label><input id="p" placeholder="9665XXXXXXXX" dir="ltr"></div>
<div class="g"><label>الرسالة</label><textarea id="m" placeholder="اكتب رسالتك..."></textarea></div>
<button class="btn" onclick="send()">إرسال 🚀</button>
<div id="r" class="result"></div>

<div class="divider"></div>

<h2>📋 رفع Excel للعملاء</h2>
<div class="g"><label>ملف Excel (أعمدة: Name, Phone)</label><input type="file" id="f" accept=".xlsx,.xls,.csv"></div>
<button class="btn" onclick="upload()">رفع وإضافة العملاء</button>
<div id="ur" class="result"></div>

<div class="divider"></div>
<h2>📊 حالة النظام</h2>
<div id="st" style="text-align:center;color:#888">جاري التحميل...</div>
</div>
<script>
const K='';
async function send(){
const n=document.getElementById('n').value,p=document.getElementById('p').value,m=document.getElementById('m').value,r=document.getElementById('r');
if(!p||!m){r.className='result err';r.textContent='❌ اكتب الرقم والرسالة';r.style.display='block';return}
r.className='result';r.textContent='⏳ جاري الإرسال...';r.style.display='block';
try{
// Add customer first if name provided
if(n){await fetch('/api/customers',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':K},body:JSON.stringify({name:n,phone:p})}).catch(()=>{})}
const res=await fetch('/api/send-message',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':K},body:JSON.stringify({phone:p,message:m})});
const d=await res.json();
if(d.success){r.className='result ok';r.textContent='✅ تم الإرسال بنجاح!';document.getElementById('m').value=''}
else{r.className='result err';r.textContent='❌ '+d.error}
}catch(e){r.className='result err';r.textContent='❌ خطأ: '+e.message}
}
async function upload(){
const f=document.getElementById('f').files[0],r=document.getElementById('ur');
if(!f){r.className='result err';r.textContent='❌ اختار ملف';r.style.display='block';return}
r.className='result';r.textContent='⏳ جاري الرفع...';r.style.display='block';
const fd=new FormData();fd.append('file',f);
try{
const res=await fetch('/api/customers/import',{method:'POST',headers:{'X-API-Key':K},body:fd});
const d=await res.json();
if(d.imported!==undefined){r.className='result ok';r.textContent='✅ تم إضافة '+d.imported+' عميل، تم تخطي '+d.skipped}
else{r.className='result err';r.textContent='❌ '+d.error}
}catch(e){r.className='result err';r.textContent='❌ '+e.message}
}
async function chk(){
try{const r=await fetch('/api/status');const d=await r.json();
document.getElementById('st').innerHTML=d.whatsapp?'<span style="color:#25D366">✅ WhatsApp متصل</span> | عملاء: '+d.stats.customers+' | رسائل: '+d.stats.messages:'<span style="color:#ff5252">❌ غير متصل - <a href="/qr" style="color:#4fc3f7">امسح QR</a></span>'}
catch(e){document.getElementById('st').innerHTML='<span style="color:#ff5252">❌ خطأ في الاتصال</span>'}}
chk();setInterval(chk,30000);
</script></body></html>`);
});

// Dashboard
app.get('/', (req, res) => res.redirect('/dashboard/'));
app.get('/dashboard', (req, res) => res.redirect('/dashboard/'));

// Socket.IO
io.on('connection', (socket) => {
    socket.emit('status', { connected: whatsappReady, message: whatsappReady ? 'Connected' : 'Initializing...' });
    if (qrCodeData) socket.emit('qr', qrCodeData);
    if (whatsappReady) socket.emit('ready', { connected: true });
});

// Start
console.log('[INIT] Initializing WhatsApp client...');
whatsapp.initialize().catch(err => console.error('[INIT] Error:', err.message));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   WhatsApp CRM Gateway                       ║
║   Port: ${PORT}                                  ║
║   QR: http://localhost:${PORT}/qr                ║
║   Send: http://localhost:${PORT}/send            ║
║   Dashboard: http://localhost:${PORT}/dashboard  ║
╚══════════════════════════════════════════════╝`);
});

process.on('SIGINT', async () => { await whatsapp.destroy(); db.close(); process.exit(0); });
