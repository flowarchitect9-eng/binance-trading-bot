const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

app.post('/api/login', (req, res) => {
    res.json({ success: true, token: 'cyberpunk_authenticated_session_token_999' });
});

app.get('/api/status', async (req, res) => {
    res.json({
        success: true,
        state: { current_balance: 1000.0, is_paused: 0, symbol: 'BTCUSDT' },
        heartbeats: [],
        recent_trades: []
    });
});

app.get('/api/trades', async (req, res) => {
    res.json({ success: true, trades: [] });
});

app.get('/api/logs', async (req, res) => {
    res.json({ success: true, logs: [] });
});

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
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
} else {
    app.get('*', (req, res) => {
        res.status(200).send('<!DOCTYPE html><html><head><title>Cyberpunk Terminal</title></head><body style="background:#020617;color:#22d3ee;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>CYBERPUNK TERMINAL ACTIVE</h2></body></html>');
    });
}

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    const server = http.createServer(app);
    server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
