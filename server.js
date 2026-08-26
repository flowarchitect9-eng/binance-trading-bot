const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const ENV_FILE_PATH = path.join(__dirname, '../.env');
const DB_FILE_PATH = path.join(__dirname, '../trading_bot.db');

let useSqlite = false;
let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    useSqlite = true;
}

const dbQuery = async (pgSql, sqliteSql, params = []) => {
    if (!useSqlite && pool) {
        try {
            const res = await pool.query(pgSql, params);
            return res.rows;
        } catch (err) {
            console.error('Postgres error, fallback to SQLite:', err.message);
        }
    }
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_FILE_PATH);
        db.all(sqliteSql, params, (err, rows) => {
            db.close();
            if (err) resolve([]);
            else resolve(rows || []);
        });
    });
};

app.post('/api/login', (req, res) => {
    res.json({ success: true, token: 'cyberpunk_authenticated_session_token_999' });
});

app.get('/api/status', async (req, res) => {
    try {
        const stateRows = await dbQuery('SELECT * FROM bot_state WHERE id = 1;', 'SELECT * FROM bot_state WHERE id = 1;');
        const hbRows = await dbQuery('SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;', 'SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;');
        const tradesRows = await dbQuery('SELECT * FROM trades ORDER BY id DESC LIMIT 10;', 'SELECT * FROM trades ORDER BY id DESC LIMIT 10;');

        const state = stateRows[0] || {};
        res.json({
            success: true,
            state: state,
            heartbeats: hbRows,
            recent_trades: tradesRows
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings', (req, res) => {
    const { email, password, trade_usd_size } = req.body;
    let envContent = '';
    if (fs.existsSync(ENV_FILE_PATH)) {
        envContent = fs.readFileSync(ENV_FILE_PATH, 'utf8');
    }
    if (email) envContent = envContent.replace(/DASHBOARD_ADMIN_EMAIL=.*/g, '') + `\nDASHBOARD_ADMIN_EMAIL=${email}`;
    if (password) envContent = envContent.replace(/DASHBOARD_ADMIN_PASSWORD=.*/g, '') + `\nDASHBOARD_ADMIN_PASSWORD=${password}`;
    fs.writeFileSync(ENV_FILE_PATH, envContent.trim() + '\n');
    res.json({ success: true, message: 'Settings updated successfully' });
});

app.get('/api/trades', async (req, res) => {
    const trades = await dbQuery('SELECT * FROM trades ORDER BY id DESC LIMIT 50;', 'SELECT * FROM trades ORDER BY id DESC LIMIT 50;');
    res.json({ success: true, trades: trades });
});

app.get('/api/logs', async (req, res) => {
    const logs = await dbQuery('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50;', 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50;');
    res.json({ success: true, logs: logs });
});

// Robust dist path discovery algorithm across all execution environments
const possibleDistPaths = [
    path.join(__dirname, 'dashboard', 'dist'),
    path.join(__dirname, 'dist'),
    path.join(__dirname, '..', 'dashboard', 'dist'),
    path.join(__dirname, '..', 'dist'),
    path.join(process.cwd(), 'dashboard', 'dist'),
    path.join(process.cwd(), 'dist')
];

let distPath = possibleDistPaths.find(p => fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html')));

if (distPath) {
    console.log(`✅ Express static serving frontend from: ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
} else {
    console.error('❌ dist path not found among candidates:', possibleDistPaths);
    app.get('*', (req, res) => {
        res.status(500).send('Dashboard frontend dist build files missing. Please run build script.');
    });
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    const sendUpdate = async () => {
        try {
            const stateRows = await dbQuery('SELECT * FROM bot_state WHERE id = 1;', 'SELECT * FROM bot_state WHERE id = 1;');
            const hbRows = await dbQuery('SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;', 'SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;');
            const tradesRows = await dbQuery('SELECT * FROM trades ORDER BY id DESC LIMIT 10;', 'SELECT * FROM trades ORDER BY id DESC LIMIT 10;');
            
            const state = stateRows[0] || {};
            ws.send(JSON.stringify({
                type: 'TICK',
                state: state,
                heartbeats: hbRows,
                recent_trades: tradesRows
            }));
        } catch (e) {}
    };

    sendUpdate();
    const interval = setInterval(sendUpdate, 2000);
    ws.on('close', () => clearInterval(interval));
});

server.listen(PORT, () => {
    console.log(`🌐 Glassmorphic Control Dashboard Backend listening on port ${PORT}`);
});
