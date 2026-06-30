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
const { Client, LocalAuth } = require('whatsapp-web.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/crm.db';
const SESSION_PATH = process.env.SESSION_PATH || './session';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const API_KEY=proces..._KEY || '';
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS) || 8000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS) || 20000;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;

[path.dirname(DB_PATH), SESSION_PATH, './uploads'].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, status TEXT DEFAULT 'active', ai_classification TEXT, tags TEXT DEFAULT '[]', notes TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, message TEXT NOT NULL, direction TEXT DEFAULT 'outgoing', status TEXT DEFAULT 'pending', error TEXT, retries INTEGER DEFAULT 0, sent_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (customer_id) REFERENCES customers(id));
    CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, message TEXT NOT NULL, classification TEXT DEFAULT 'Other', confidence REAL DEFAULT 0, raw_webhook TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (customer_id) REFERENCES customers(id));
    CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message_template TEXT NOT NULL, total_customers INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, status TEXT DEFAULT 'draft', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME);
    CREATE TABLE IF NOT EXISTS campaign_customers (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, message_id INTEGER, status TEXT DEFAULT 'pending', FOREIGN KEY (campaign_id) REFERENCES campaigns(id), FOREIGN KEY (customer_id) REFERENCES customers(id), UNIQUE(campaign_id, customer_id));
    CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_replies_customer ON replies(customer_id);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10*1024*1024 } });

function authMiddleware(req, res, next) {
    if (!API_KEY) return next();
    if (['/qr', '/status'].includes(req.path)) return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key === API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized' });
}
app.use('/api', authMiddleware);

let qrCodeData = null, whatsappReady = false, clientInfo = null;

const whatsapp = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
    }
});

whatsapp.on('qr', async (qr) => { qrCodeData = await QRCode.toDataURL(qr, {width:300}); io.emit('qr', qrCodeData); io.emit('status', {connected:false, message:'Scan QR'}); });
whatsapp.on('ready', () => { whatsappReady=true; qrCodeData=null; clientInfo=whatsapp.info; io.emit('ready', {pushname:clientInfo.pushname, phone:clientInfo.wid.user}); io.emit('status', {connected:true, message:'Connected'}); });
whatsapp.on('disconnected', (r) => { whatsappReady=false; io.emit('status', {connected:false, message:'Disconnected: '+r}); });
whatsapp.on('auth_failure', (m) => { whatsappReady=false; io.emit('status', {connected:false, message:'Auth failed'}); });

whatsapp.on('message', async (msg) => {
    if (msg.fromMe || msg.isStatus) return;
    const phone = msg.from.replace('@c.us','').replace('@g.us','');
    const body = msg.body || '';
    if (!body) return;
    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get('+'+phone);
    if (!customer) {
        db.prepare('INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)').run('Customer_'+phone, '+'+phone);
        customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get('+'+phone);
    }
    if (customer) {
        db.prepare('INSERT INTO replies (customer_id, message, raw_webhook) VALUES (?, ?, ?)').run(customer.id, body, JSON.stringify({from:msg.from, ts:msg.timestamp}));
        if (N8N_WEBHOOK_URL) fetch(N8N_WEBHOOK_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({customer_id:customer.id, customer_name:customer.name, phone:customer.phone, message:body, timestamp:new Date().toISOString()})}).catch(()=>{});
        io.emit('new-reply', {customer_id:customer.id, customer_name:customer.name, phone:customer.phone, message:body, timestamp:new Date().toISOString()});
    }
});

async function sendWhatsAppMessage(phone, message) {
    let clean = phone.replace(/[^0-9+]/g,'');
    if (clean.startsWith('+')) clean = clean.substring(1);
    return await whatsapp.sendMessage(clean+'@c.us', message);
}

function randomDelay() { return Math.floor(Math.random()*(MAX_DELAY-MIN_DELAY+1))+MIN_DELAY; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// QR page
app.get('/qr', (req,res) => res.sendFile(path.join(__dirname,'qr.html')));
app.get('/send', (req,res) => res.sendFile(path.join(__dirname,'send.html')));

// Status
app.get('/api/status', (req,res) => res.json({whatsapp:whatsappReady, client:clientInfo?{pushname:clientInfo.pushname, phone:clientInfo.wid.user}:null, uptime:process.uptime(), stats:{customers:db.prepare('SELECT COUNT(*) as c FROM customers').get().c, messages_sent:db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction='outgoing'").get().c, replies:db.prepare('SELECT COUNT(*) as c FROM replies').get().c}}));
app.get('/api/qr', (req,res) => { if(whatsappReady) return res.json({connected:true}); if(qrCodeData) return res.json({connected:false,qr:qrCodeData}); res.json({connected:false,message:'Waiting...'}); });

// Customers
app.get('/api/customers', (req,res) => {
    const {status,classification,search,page=1,limit=50} = req.query;
    let q='SELECT * FROM customers WHERE 1=1', p=[];
    if(status){q+=' AND status=?';p.push(status);}
    if(classification){q+=' AND ai_classification=?';p.push(classification);}
    if(search){q+=' AND (name LIKE ? OR phone LIKE ?)';p.push('%'+search+'%','%'+search+'%');}
    q+=' ORDER BY created_at DESC LIMIT ? OFFSET ?';p.push(+limit,(+page-1)*+limit);
    res.json({customers:db.prepare(q).all(...p), total:db.prepare('SELECT COUNT(*) as c FROM customers').get().c, page:+page, limit:+limit});
});
app.post('/api/customers', (req,res) => {
    const {name,phone} = req.body;
    if(!name||!phone) return res.status(400).json({error:'name and phone required'});
    try{const r=db.prepare('INSERT INTO customers (name,phone) VALUES (?,?)').run(name,phone);res.json({id:r.lastInsertRowid,name,phone,status:'active'});}
    catch(e){if(e.message.includes('UNIQUE'))return res.status(409).json({error:'Phone exists'});res.status(500).json({error:e.message});}
});
app.put('/api/customers/:id', (req,res) => {
    const {name,phone,status,ai_classification,tags,notes} = req.body;
    const sets=[],params=[];
    if(name){sets.push('name=?');params.push(name);}
    if(phone){sets.push('phone=?');params.push(phone);}
    if(status){sets.push('status=?');params.push(status);}
    if(ai_classification!==undefined){sets.push('ai_classification=?');params.push(ai_classification);}
    if(tags){sets.push('tags=?');params.push(JSON.stringify(tags));}
    if(notes!==undefined){sets.push('notes=?');params.push(notes);}
    if(!sets.length) return res.status(400).json({error:'Nothing to update'});
    sets.push('updated_at=CURRENT_TIMESTAMP');params.push(req.params.id);
    db.prepare('UPDATE customers SET '+sets.join(',')+' WHERE id=?').run(...params);
    res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id));
});

// Import Excel
app.post('/api/customers/import', upload.single('file'), (req,res) => {
    if(!req.file) return res.status(400).json({error:'No file'});
    try{
        const wb=XLSX.readFile(req.file.path), data=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        const ins=db.prepare('INSERT OR IGNORE INTO customers (name,phone) VALUES (?,?)');
        const tx=db.transaction((rows)=>{let ok=0,sk=0;for(const r of rows){const n=r.Name||r.name||r['']||'';let p=r.Phone||r.phone||r['']||'';if(!n||!p){sk++;continue;}p=String(p).replace(/[^0-9+]/g,'');if(!p.startsWith('+'))p='+'+p;try{ins.run(n,p);ok++;}catch(e){sk++;}}return{ok,sk};});
        const r=tx(data);fs.unlinkSync(req.file.path);
        res.json({total:data.length,imported:r.ok,skipped:r.sk});
    }catch(e){res.status(500).json({error:e.message});}
});

// Send message
app.post('/api/send-message', async (req,res) => {
    if(!whatsappReady) return res.status(503).json({error:'WhatsApp not connected'});
    const {customer_id,phone,message} = req.body;
    if(!message) return res.status(400).json({error:'message required'});
    let targetPhone=phone, custId=customer_id;
    if(custId){const c=db.prepare('SELECT * FROM customers WHERE id=?').get(custId);if(!c)return res.status(404).json({error:'Customer not found'});targetPhone=c.phone;}
    else if(targetPhone){let c=db.prepare('SELECT * FROM customers WHERE phone=?').get(targetPhone);if(!c){const r=db.prepare('INSERT INTO customers (name,phone) VALUES (?,?)').run('Customer',targetPhone);custId=r.lastInsertRowid;}else{custId=c.id;}}
    if(!targetPhone) return res.status(400).json({error:'phone or customer_id required'});
    const msg=db.prepare("INSERT INTO messages (customer_id,message,status) VALUES (?,?,'sending')").run(custId||0,message);
    try{await sendWhatsAppMessage(targetPhone,message);db.prepare("UPDATE messages SET status='sent',sent_at=CURRENT_TIMESTAMP WHERE id=?").run(msg.lastInsertRowid);res.json({success:true,message_id:msg.lastInsertRowid,status:'sent'});}
    catch(e){db.prepare("UPDATE messages SET status='failed',error=? WHERE id=?").run(e.message,msg.lastInsertRowid);res.status(500).json({success:false,error:e.message,message_id:msg.lastInsertRowid});}
});

// Campaigns
app.post('/api/campaigns', (req,res) => {
    const {name,message_template,customer_ids}=req.body;
    if(!name||!message_template) return res.status(400).json({error:'name and message_template required'});
    const camp=db.prepare('INSERT INTO campaigns (name,message_template) VALUES (?,?)').run(name,message_template);
    let customers;
    if(customer_ids&&customer_ids.length){const ph=customer_ids.map(()=>'?').join(',');customers=db.prepare('SELECT * FROM customers WHERE id IN ('+ph+') AND status=?').all(...customer_ids,'active');}
    else{customers=db.prepare("SELECT * FROM customers WHERE status='active'").all();}
    const ls=db.prepare('INSERT OR IGNORE INTO campaign_customers (campaign_id,customer_id) VALUES (?,?)');
    for(const c of customers) ls.run(camp.lastInsertRowid,c.id);
    db.prepare('UPDATE campaigns SET total_customers=?,status=? WHERE id=?').run(customers.length,'active',camp.lastInsertRowid);
    res.json({campaign_id:camp.lastInsertRowid,name,total_customers:customers.length,status:'active'});
});
app.post('/api/campaigns/:id/send', async (req,res) => {
    if(!whatsappReady) return res.status(503).json({error:'WhatsApp not connected'});
    const cid=req.params.id, camp=db.prepare('SELECT * FROM campaigns WHERE id=?').get(cid);
    if(!camp) return res.status(404).json({error:'Campaign not found'});
    const pending=db.prepare("SELECT cc.*,c.name,c.phone FROM campaign_customers cc JOIN customers c ON c.id=cc.customer_id WHERE cc.campaign_id=? AND cc.status='pending'").all(cid);
    if(!pending.length) return res.json({message:'No pending',campaign_id:cid});
    res.json({campaign_id:cid,pending:pending.length,message:'Sending '+pending.length+' messages'});
    processCampaign(cid,camp.message_template,pending);
});
async function processCampaign(cid,tpl,customers){
    for(const c of customers){
        try{
            const msg=tpl.replace(/\{\{Name\}\}/gi,c.name).replace(/\{\{Phone\}\}/gi,c.phone);
            const mr=db.prepare("INSERT INTO messages (customer_id,message,direction,status) VALUES (?,?,'outgoing','sending')").run(c.customer_id,msg);
            try{await sendWhatsAppMessage(c.phone,msg);db.prepare("UPDATE messages SET status='sent',sent_at=CURRENT_TIMESTAMP WHERE id=?").run(mr.lastInsertRowid);db.prepare("UPDATE campaign_customers SET status='sent',message_id=? WHERE campaign_id=? AND customer_id=?").run(mr.lastInsertRowid,cid,c.customer_id);db.prepare('UPDATE campaigns SET sent_count=sent_count+1 WHERE id=?').run(cid);io.emit('campaign-progress',{campaignId:cid,customer:c.name,status:'sent'});}
            catch(e){db.prepare("UPDATE messages SET status='failed',error=? WHERE id=?").run(e.message,mr.lastInsertRowid);db.prepare("UPDATE campaign_customers SET status='failed' WHERE campaign_id=? AND customer_id=?").run(cid,c.customer_id);db.prepare('UPDATE campaigns SET failed_count=failed_count+1 WHERE id=?').run(cid);}
            await sleep(randomDelay());
        }catch(e){}
    }
    db.prepare("UPDATE campaigns SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(cid);
    io.emit('campaign-complete',{campaignId:cid});
}
app.get('/api/campaigns', (req,res)=>res.json(db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all()));
app.get('/api/campaigns/:id', (req,res)=>{const c=db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);if(!c)return res.status(404).json({error:'Not found'});res.json({...c,customers:db.prepare('SELECT cc.status as send_status,c.* FROM campaign_customers cc JOIN customers c ON c.id=cc.customer_id WHERE cc.campaign_id=?').all(req.params.id)});});

// Messages & Replies
app.get('/api/messages', (req,res)=>{const{customer_id,status,direction,page=1,limit=50}=req.query;let q='SELECT m.*,c.name as customer_name,c.phone as customer_phone FROM messages m LEFT JOIN customers c ON c.id=m.customer_id WHERE 1=1',p=[];if(customer_id){q+=' AND m.customer_id=?';p.push(customer_id);}if(status){q+=' AND m.status=?';p.push(status);}if(direction){q+=' AND m.direction=?';p.push(direction);}q+=' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';p.push(+limit,(+page-1)*+limit);res.json(db.prepare(q).all(...p));});
app.get('/api/replies', (req,res)=>{const{customer_id,classification,page=1,limit=50}=req.query;let q='SELECT r.*,c.name as customer_name,c.phone as customer_phone FROM replies r LEFT JOIN customers c ON c.id=r.customer_id WHERE 1=1',p=[];if(customer_id){q+=' AND r.customer_id=?';p.push(customer_id);}if(classification){q+=' AND r.classification=?';p.push(classification);}q+=' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';p.push(+limit,(+page-1)*+limit);res.json(db.prepare(q).all(...p));});
app.post('/api/replies/:id/classify', (req,res)=>{const{classification,confidence}=req.body;if(!classification)return res.status(400).json({error:'required'});db.prepare('UPDATE replies SET classification=?,confidence=? WHERE id=?').run(classification,confidence||0,req.params.id);const r=db.prepare('SELECT * FROM replies WHERE id=?').get(req.params.id);if(r)db.prepare('UPDATE customers SET ai_classification=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(classification,r.customer_id);res.json({success:true});});
app.post('/api/reply', async(req,res)=>{if(!whatsappReady)return res.status(503).json({error:'WhatsApp not connected'});const{customer_id,message}=req.body;if(!customer_id||!message)return res.status(400).json({error:'required'});const c=db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);if(!c)return res.status(404).json({error:'Not found'});try{await sendWhatsAppMessage(c.phone,message);db.prepare("INSERT INTO messages (customer_id,message,direction,status,sent_at) VALUES (?,?,'outgoing','sent',CURRENT_TIMESTAMP)").run(customer_id,message);res.json({success:true});}catch(e){res.status(500).json({error:e.message});}});

// Stats
app.get('/api/stats', (req,res)=>{
    res.json({
        customers:{total:db.prepare('SELECT COUNT(*) as c FROM customers').get().c,active:db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='active'").get().c,classified:{interested:db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Interested'").get().c,not_interested:db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Not Interested'").get().c,follow_up:db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Follow Up'").get().c,asking_price:db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Asking Price'").get().c,other:db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification='Other'").get().c,unclassified:db.prepare("SELECT COUNT(*) as c FROM customers WHERE ai_classification IS NULL").get().c}},
        messages:{total:db.prepare('SELECT COUNT(*) as c FROM messages').get().c,sent:db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='sent'").get().c,failed:db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='failed'").get().c,pending:db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='pending'").get().c},
        replies:{total:db.prepare('SELECT COUNT(*) as c FROM replies').get().c,by_class:{Interested:db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Interested'").get().c,'Not Interested':db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Not Interested'").get().c,'Follow Up':db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Follow Up'").get().c,'Asking Price':db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Asking Price'").get().c,Other:db.prepare("SELECT COUNT(*) as c FROM replies WHERE classification='Other'").get().c}},
        campaigns:{total:db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c,active:db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status='active'").get().c,completed:db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status='completed'").get().c},
        no_reply:db.prepare("SELECT COUNT(*) as c FROM customers WHERE id NOT IN (SELECT DISTINCT customer_id FROM replies) AND id IN (SELECT DISTINCT customer_id FROM messages WHERE direction='outgoing')").get().c
    });
});

app.get('/health', (req,res)=>res.json({status:'ok',whatsapp:whatsappReady,uptime:process.uptime()}));
app.get('/', (req,res)=>res.redirect('/dashboard/'));

io.on('connection', (s)=>{s.emit('status',{connected:whatsappReady,message:whatsappReady?'Connected':'Initializing...'});if(qrCodeData)s.emit('qr',qrCodeData);if(whatsappReady&&clientInfo)s.emit('ready',{pushname:clientInfo.pushname,phone:clientInfo.wid.user});});

console.log('[INIT] Starting WhatsApp client...');
whatsapp.initialize().catch(e=>console.error('[INIT]',e.message));

server.listen(PORT,'0.0.0.0',()=>console.log('WhatsApp CRM Gateway running on port '+PORT));

process.on('SIGINT', async()=>{await whatsapp.destroy();db.close();server.close();process.exit(0);});
