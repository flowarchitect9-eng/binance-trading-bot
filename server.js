const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const ENV_FILE_PATH = path.join(__dirname, '../.env');
const DB_FILE_PATH = path.join(__dirname, '../trading_bot.db');

let useSqlite = false;
let pool = null;

if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000
    });
}

function getSqliteDb() {
    return new sqlite3.Database(DB_FILE_PATH);
}

async function dbQuery(pgQuery, sqliteQuery, params = []) {
    if (!useSqlite && pool) {
        try {
            const res = await pool.query(pgQuery, params);
            return res.rows;
        } catch (e) {
            useSqlite = true;
        }
    }
    
    return new Promise((resolve) => {
        const db = getSqliteDb();
        db.all(sqliteQuery, params, (err, rows) => {
            db.close();
            if (err) resolve([]);
            else resolve(rows || []);
        });
    });
}

async function dbExecute(pgQuery, sqliteQuery, params = []) {
    if (!useSqlite && pool) {
        try {
            await pool.query(pgQuery, params);
            return true;
        } catch (e) {
            useSqlite = true;
        }
    }
    return new Promise((resolve) => {
        const db = getSqliteDb();
        db.run(sqliteQuery, params, (err) => {
            db.close();
            resolve(true);
        });
    });
}

async function fetchBinanceKlines(symbol = 'BTCUSDT') {
    try {
        const mode = process.env.TRADING_MODE || 'TESTNET';
        const baseUrl = mode === 'PRODUCTION' ? 'https://api.binance.com' : 'https://testnet.binance.vision';
        const res = await axios.get(`${baseUrl}/api/v3/klines?symbol=${symbol}&interval=1m&limit=35`, { timeout: 3000 });
        return res.data.map(k => ({
            time: new Date(k[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            isGreen: parseFloat(k[4]) >= parseFloat(k[1])
        }));
    } catch (e) {
        return [];
    }
}

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/status', async (req, res) => {
    try {
        const stateRows = await dbQuery('SELECT * FROM bot_state WHERE id = 1;', 'SELECT * FROM bot_state WHERE id = 1;');
        const hbRows = await dbQuery('SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;', 'SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;');
        const statsRows = await dbQuery(
            `SELECT COUNT(*) as total_trades, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, COALESCE(SUM(pnl), 0) as total_pnl FROM trades WHERE side = 'SELL';`,
            `SELECT COUNT(*) as total_trades, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, COALESCE(SUM(pnl), 0) as total_pnl FROM trades WHERE side = 'SELL';`
        );
        const state = stateRows[0] || {};
        const activeSymbol = state.symbol || process.env.SYMBOL || 'BTCUSDT';
        const klines = await fetchBinanceKlines(activeSymbol);

        const stats = statsRows[0] || {};
        const totalTrades = parseInt(stats.total_trades || 0);
        const wins = parseInt(stats.wins || 0);
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;

        res.json({
            success: true,
            state: state,
            heartbeats: hbRows.reverse(),
            klines: klines,
            metrics: {
                totalBalance: parseFloat(state.current_balance || 1000.0),
                totalPnL: parseFloat(stats.total_pnl || 0.0),
                winRate: parseFloat(winRate),
                totalTrades: totalTrades
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Daily & Historical Performance Review Reports
app.get('/api/daily-reports', async (req, res) => {
    try {
        const pgQuery = `
            SELECT 
                DATE(created_at) as trade_date,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as win_count,
                SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as loss_count,
                COALESCE(SUM(pnl), 0) as daily_pnl,
                COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct
            FROM trades 
            WHERE side = 'SELL'
            GROUP BY DATE(created_at)
            ORDER BY trade_date DESC;
        `;
        const sqliteQuery = `
            SELECT 
                DATE(created_at) as trade_date,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as win_count,
                SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as loss_count,
                COALESCE(SUM(pnl), 0) as daily_pnl,
                COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct
            FROM trades 
            WHERE side = 'SELL'
            GROUP BY DATE(created_at)
            ORDER BY trade_date DESC;
        `;
        const reports = await dbQuery(pgQuery, sqliteQuery);
        res.json({ success: true, reports });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/change-symbol', async (req, res) => {
    try {
        const { symbol } = req.body;
        if (!symbol) return res.status(400).json({ success: false, error: 'Symbol missing!' });

        await dbExecute(
            `UPDATE bot_state SET symbol = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;`,
            `UPDATE bot_state SET symbol = '${symbol}', updated_at = DATETIME('now') WHERE id = 1;`,
            [symbol]
        );

        let envContent = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, 'utf8') : '';
        const regex = /^SYMBOL=.*$/m;
        if (envContent.match(regex)) {
            envContent = envContent.replace(regex, `SYMBOL=${symbol}`);
        } else {
            envContent += `\nSYMBOL=${symbol}`;
        }
        process.env.SYMBOL = symbol;
        fs.writeFileSync(ENV_FILE_PATH, envContent.trim() + '\n');

        await dbExecute(
            `INSERT INTO audit_logs (log_level, message) VALUES ('INFO', 'Active symbol switched to ${symbol} from Dashboard.');`,
            `INSERT INTO audit_logs (log_level, message) VALUES ('INFO', 'Active symbol switched to ${symbol} from Dashboard.');`
        );

        res.json({ success: true, symbol: symbol, message: `Successfully switched scanning coin to ${symbol}!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/settings', (req, res) => {
    res.json({
        success: true,
        tradingMode: process.env.TRADING_MODE || 'TESTNET',
        enableRealMoney: process.env.ENABLE_REAL_MONEY_TRADING === 'true',
        binanceTestnetKey: process.env.BINANCE_TESTNET_API_KEY || '',
        binanceTestnetSecret: process.env.BINANCE_TESTNET_API_SECRET ? '••••••••••••' : '',
        binanceLiveKey: process.env.BINANCE_LIVE_API_KEY || '',
        binanceLiveSecret: process.env.BINANCE_LIVE_API_SECRET ? '••••••••••••' : '',
        telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
        telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
    });
});

app.post('/api/settings', async (req, res) => {
    try {
        const { 
            tradingMode, enableRealMoney, 
            binanceTestnetKey, binanceTestnetSecret,
            binanceLiveKey, binanceLiveSecret,
            telegramToken, telegramChatId 
        } = req.body;

        let envContent = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, 'utf8') : '';

        function updateEnvKey(key, value) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (envContent.match(regex)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
            process.env[key] = String(value);
        }

        if (tradingMode !== undefined) updateEnvKey('TRADING_MODE', tradingMode);
        if (enableRealMoney !== undefined) updateEnvKey('ENABLE_REAL_MONEY_TRADING', String(enableRealMoney));
        if (binanceTestnetKey !== undefined) updateEnvKey('BINANCE_TESTNET_API_KEY', binanceTestnetKey);
        if (binanceTestnetSecret && binanceTestnetSecret !== '••••••••••••') updateEnvKey('BINANCE_TESTNET_API_SECRET', binanceTestnetSecret);
        if (binanceLiveKey !== undefined) updateEnvKey('BINANCE_LIVE_API_KEY', binanceLiveKey);
        if (binanceLiveSecret && binanceLiveSecret !== '••••••••••••') updateEnvKey('BINANCE_LIVE_API_SECRET', binanceLiveSecret);
        if (telegramToken !== undefined) updateEnvKey('TELEGRAM_BOT_TOKEN', telegramToken);
        if (telegramChatId !== undefined) updateEnvKey('TELEGRAM_CHAT_ID', telegramChatId);

        fs.writeFileSync(ENV_FILE_PATH, envContent.trim() + '\n');

        await dbExecute(
            "INSERT INTO audit_logs (log_level, message) VALUES ('INFO', 'API Keys and Settings updated from Dashboard.');",
            "INSERT INTO audit_logs (log_level, message) VALUES ('INFO', 'API Keys and Settings updated from Dashboard.');"
        );

        res.json({ success: true, message: 'Settings saved live to .env!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/test-telegram', async (req, res) => {
    const { token, chatId } = req.body;
    const botToken = token || process.env.TELEGRAM_BOT_TOKEN;
    const chat = chatId || process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chat) {
        return res.status(400).json({ success: false, error: 'Telegram Token or Chat ID missing!' });
    }

    try {
        const msg = `⚡ <b>BINANCE TRADING PLATFORM TEST ALERT</b>\n\nTelegram notification engine connected successfully!`;
        const teleRes = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chat,
            text: msg,
            parse_mode: 'HTML'
        });

        if (teleRes.status === 200) {
            res.json({ success: true, message: 'Test message delivered to Telegram!' });
        } else {
            res.status(400).json({ success: false, error: teleRes.data.description });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/panic', async (req, res) => {
    try {
        await dbExecute(
            `UPDATE bot_state SET is_paused = true, position_open = false, buy_price = 0, quantity = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 1;`,
            `UPDATE bot_state SET is_paused = 1, position_open = 0, buy_price = 0, quantity = 0, updated_at = DATETIME('now') WHERE id = 1;`
        );
        await dbExecute(
            `INSERT INTO audit_logs (log_level, message) VALUES ('SECURITY_LOCK', 'EMERGENCY PANIC BUTTON TRIGGERED FROM DASHBOARD.');`,
            `INSERT INTO audit_logs (log_level, message) VALUES ('SECURITY_LOCK', 'EMERGENCY PANIC BUTTON TRIGGERED FROM DASHBOARD.');`
        );
        res.json({ success: true, message: 'EMERGENCY PANIC EXECUTED: Bot Halted & Position Reset.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/toggle-mode', async (req, res) => {
    try {
        const { is_paused } = req.body;
        const val = is_paused ? 1 : 0;
        await dbExecute(
            `UPDATE bot_state SET is_paused = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;`,
            `UPDATE bot_state SET is_paused = ${val}, updated_at = DATETIME('now') WHERE id = 1;`,
            [is_paused]
        );
        res.json({ success: true, is_paused: is_paused });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/tune-params', async (req, res) => {
    try {
        const { trade_usd_size } = req.body;
        await dbExecute(
            `UPDATE bot_state SET trade_usd_size = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;`,
            `UPDATE bot_state SET trade_usd_size = ${parseFloat(trade_usd_size)}, updated_at = DATETIME('now') WHERE id = 1;`,
            [trade_usd_size]
        );
        res.json({ success: true, message: 'Parameters updated live!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/trades', async (req, res) => {
    const trades = await dbQuery('SELECT * FROM trades ORDER BY id DESC LIMIT 50;', 'SELECT * FROM trades ORDER BY id DESC LIMIT 50;');
    res.json({ success: true, trades: trades });
});

app.get('/api/logs', async (req, res) => {
    const logs = await dbQuery('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50;', 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50;');
    res.json({ success: true, logs: logs });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist/index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    const sendUpdate = async () => {
        try {
            const stateRows = await dbQuery('SELECT * FROM bot_state WHERE id = 1;', 'SELECT * FROM bot_state WHERE id = 1;');
            const hbRows = await dbQuery('SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;', 'SELECT * FROM bot_heartbeat ORDER BY id DESC LIMIT 30;');
            const tradesRows = await dbQuery('SELECT * FROM trades ORDER BY id DESC LIMIT 10;', 'SELECT * FROM trades ORDER BY id DESC LIMIT 10;');
            
            const state = stateRows[0] || {};
            const activeSymbol = state.symbol || process.env.SYMBOL || 'BTCUSDT';
            const klines = await fetchBinanceKlines(activeSymbol);

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'LATEST_METRICS',
                    state: state,
                    heartbeat: hbRows[0] || {},
                    klines: klines,
                    recentHeartbeats: hbRows.reverse(),
                    recentTrades: tradesRows
                }));
            }
        } catch (e) {
            // silent catch
        }
    };

    const interval = setInterval(sendUpdate, 1200);
    ws.on('close', () => clearInterval(interval));
});

server.listen(PORT, () => {
    console.log(`🌐 Glassmorphic Control Dashboard Backend listening on port ${PORT}`);
});
