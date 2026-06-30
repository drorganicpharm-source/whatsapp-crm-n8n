# WhatsApp CRM System 📱

نظام CRM متكامل لإدارة حملات رسائل واتساب مع تصنيف الردود بالذكاء الاصطناعي.

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Excel File    │────▶│     n8n      │────▶│   WhatsApp      │
│   (Customers)   │     │  (Workflows) │     │   Gateway       │
└─────────────────┘     └──────┬───────┘     └────────┬────────┘
                               │                      │
                               ▼                      ▼
                        ┌──────────────┐     ┌─────────────────┐
                        │   SQLite     │     │  WhatsApp Web   │
                        │   Database   │     │  (whatsapp-web) │
                        └──────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  Dashboard   │
                        │  (HTML/CSS)  │
                        └──────────────┘
```

## 🚀 Quick Start (Local)

### Prerequisites
- Docker & Docker Compose
- Node.js 18+ (for local development)

### 1. Clone & Configure
```bash
git clone <your-repo>
cd whatsapp-crm
cp .env.example .env
# Edit .env with your settings
```

### 2. Start with Docker
```bash
docker-compose up -d
```

### 3. Access
- **WhatsApp Gateway**: http://localhost:3000
- **n8n Workflows**: http://localhost:5678
- **Dashboard**: http://localhost:3000/dashboard
- **API Docs**: http://localhost:3000/api/status

### 4. Connect WhatsApp
1. Open http://localhost:3000/api/qr
2. Scan the QR code with WhatsApp on your phone
3. Wait for "Connected" status

## 🚂 Deploy on Railway

### Option 1: Deploy from GitHub
1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app)
3. Create New Project → Deploy from GitHub
4. Select this repo
5. Railway will auto-detect the Dockerfile

### Option 2: Railway CLI
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Init project
railway init

# Add environment variables
railway variables set API_KEY=your-secret-key
railway variables set N8N_WEBHOOK_URL=https://your-n8n-url/webhook/whatsapp-incoming

# Deploy
railway up
```

### Railway Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Gateway port | `3000` |
| `API_KEY` | API authentication key | (required) |
| `N8N_WEBHOOK_URL` | n8n webhook for incoming messages | - |
| `MIN_DELAY_MS` | Min delay between messages | `8000` |
| `MAX_DELAY_MS` | Max delay between messages | `20000` |
| `MAX_RETRIES` | Max retry attempts | `3` |

## 📋 API Endpoints

### Status
```
GET /api/status          - Gateway status & stats
GET /health              - Health check
GET /api/qr              - Get QR code for WhatsApp
```

### Customers
```
GET    /api/customers           - List customers (with pagination)
POST   /api/customers           - Add single customer
PUT    /api/customers/:id       - Update customer
POST   /api/customers/import    - Import from Excel file
```

### Messages & Campaigns
```
POST   /api/send-message        - Send single message
POST   /api/campaigns           - Create campaign
POST   /api/campaigns/:id/send  - Start sending campaign
POST   /api/campaigns/:id/retry - Retry failed messages
GET    /api/campaigns           - List campaigns
GET    /api/campaigns/:id       - Campaign details
```

### Replies & Classification
```
GET    /api/replies             - List replies
POST   /api/replies/:id/classify - Update AI classification
POST   /api/reply               - Send reply to customer
```

### Dashboard
```
GET    /api/stats               - Full statistics
```

## 🔄 n8n Workflows

Import these workflows into n8n:

### Workflow 1: Import Customers
- **Trigger**: POST webhook
- **Action**: Reads Excel file and imports to gateway

### Workflow 2: Send Campaign
- **Trigger**: POST webhook with campaign name & message template
- **Action**: Creates campaign and starts sending with delays

### Workflow 3: Receive Replies
- **Trigger**: Webhook from gateway (auto-forwarded)
- **Action**: Stores and processes incoming messages

### Workflow 4: AI Classification
- **Trigger**: POST webhook with reply data
- **Action**: Uses OpenAI to classify replies into categories
- **Categories**: Interested, Not Interested, Follow Up, Asking Price, Other

### Workflow 5: Dashboard Stats
- **Trigger**: GET webhook
- **Action**: Returns aggregated statistics

### Importing Workflows
1. Open n8n at http://localhost:5678
2. Go to Workflows → Import
3. Upload each JSON file from `n8n-workflows/`
4. Configure credentials (OpenAI API key for classification)
5. Activate the workflows

## 💬 Message Template

Use `{{Name}}` as placeholder for customer name:
```
السلام عليكم {{Name}} 👋

نتشرف بتواصلك معنا. كيف نقدر نساعدك اليوم؟
```

## 📊 Data Structure

### Customers Table
| Field | Type | Description |
|-------|------|-------------|
| id | INTEGER | Primary key |
| name | TEXT | Customer name |
| phone | TEXT | Phone (unique, +966 format) |
| status | TEXT | active/inactive/blocked |
| ai_classification | TEXT | Latest AI classification |
| tags | JSON | Custom tags |
| notes | TEXT | Notes |

### Messages Table
| Field | Type | Description |
|-------|------|-------------|
| id | INTEGER | Primary key |
| customer_id | INTEGER | FK to customers |
| message | TEXT | Message content |
| direction | TEXT | incoming/outgoing |
| status | TEXT | pending/sent/failed |
| error | TEXT | Error message if failed |
| retries | INTEGER | Retry count |

### Replies Table
| Field | Type | Description |
|-------|------|-------------|
| id | INTEGER | Primary key |
| customer_id | INTEGER | FK to customers |
| message | TEXT | Reply content |
| classification | TEXT | AI classification |
| confidence | REAL | Classification confidence |

## ⚡ Rate Limiting & Anti-Ban

The system includes built-in protections:
- **Random delays**: 8-20 seconds between messages (configurable)
- **Retry logic**: Failed messages retry up to 3 times
- **Resume support**: Campaigns can be paused and resumed
- **No duplicates**: Won't re-send to same customer in a campaign

## 🔧 Development

### Run locally without Docker
```bash
# Terminal 1: WhatsApp Gateway
cd whatsapp-gateway
npm install
npm run dev

# Terminal 2: n8n
npx n8n start
```

### Project Structure
```
whatsapp-crm/
├── docker-compose.yml          # Docker orchestration
├── railway.json                # Railway deployment config
├── .env.example                # Environment template
├── .gitignore
├── whatsapp-gateway/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js               # Main server (Express + WhatsApp)
│   └── .dockerignore
├── database/
│   └── seed.js                 # Sample data generator
├── n8n-workflows/
│   ├── 01-import-customers.json
│   ├── 02-send-campaign.json
│   ├── 03-receive-replies.json
│   ├── 04-ai-classification.json
│   └── 05-dashboard.json
├── dashboard/
│   └── index.html              # Dashboard UI
└── README.md
```

## 📝 Example: Send a Campaign

```bash
# 1. Import customers from Excel
curl -X POST http://localhost:3000/api/customers/import \
  -H "X-API-Key: your-key" \
  -F "file=@customers.xlsx"

# 2. Create and send campaign
curl -X POST http://localhost:3000/api/campaigns \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Summer Sale 2024",
    "message_template": "السلام عليكم {{Name}} 👋\n\nعندي لك عرض خاص بمناسبة الصيف! تبي تعرف التفاصيل؟"
  }'

# 3. Start sending (campaign_id from step 2)
curl -X POST http://localhost:3000/api/campaigns/1/send \
  -H "X-API-Key: your-key"

# 4. Check stats
curl http://localhost:3000/api/stats
```

## ⚠️ Important Notes

1. **WhatsApp Web Unofficial**: This uses whatsapp-web.js which is NOT officially supported by WhatsApp/Meta. Use at your own risk.

2. **Phone Number Format**: Always use international format: `+966xxxxxxxxx`

3. **Session Persistence**: WhatsApp session is saved in `./session` volume. Don't delete it or you'll need to re-scan QR.

4. **Rate Limits**: WhatsApp may temporarily ban numbers that send too many messages. Keep delays reasonable (8-20s recommended).

5. **OpenAI API**: AI classification requires an OpenAI API key configured in n8n credentials.

## 📄 License

MIT

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request
