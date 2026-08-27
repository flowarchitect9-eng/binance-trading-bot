const express = require('express');
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

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        state: { current_balance: 1000.0, is_paused: 0, symbol: 'BTCUSDT' },
        heartbeats: [
            { close_price: 78420.50, rsi: 28.40, macd: 23.23, signal_line: 18.50, created_at: new Date().toISOString() }
        ],
        recent_trades: []
    });
});

app.get('/api/trades', (req, res) => {
    res.json({ success: true, trades: [] });
});

app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: [] });
});

app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: 'API route not found' });
});

// Always serve fresh root index.html natively
app.get('*', (req, res) => {
    const rootIndexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(rootIndexPath)) {
        res.sendFile(rootIndexPath);
    } else {
        res.status(200).send('Cyberpunk Trading Terminal Online');
    }
});

// Bind to 0.0.0.0 for Railway & Docker containers
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Cyberpunk Trading Dashboard listening on 0.0.0.0:${PORT}`);
});

module.exports = app;
