const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// Render Persistence: Use /opt/render/project/data if available
const DATA_DIR = process.env.DATA_DIR || __dirname;

// Ensure Data Directory Exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'tokens.db');
console.log(`Database path: ${DB_PATH}`);

// Initialize DB
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database', err);
    } else {
        console.log('Connected to the SQLite database.');
        // Create table if not exists
        db.run(`CREATE TABLE IF NOT EXISTS tokens (
            token TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            used INTEGER DEFAULT 0,
            used_at DATETIME
        )`);
    }
});

app.use(express.json());
app.use(express.static('public'));

// CORS Configuration
const allowedOrigins = [
    'https://mentrastchat.vercel.app',
    'http://localhost:3000',
    'https://mentrast-lp.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// Helper to generate 7-char alphanumeric token
function generateToken() {
    return crypto.randomBytes(4).toString('hex').slice(0, 7).toUpperCase();
}

// 1. Generate Tokens (Admin)
app.post('/api/generate', (req, res) => {
    const count = req.body.count || 1;
    const successfulTokens = [];

    const insertToken = () => {
        return new Promise((resolve) => {
            const token = generateToken();
            db.run('INSERT INTO tokens (token) VALUES (?)', [token], function (err) {
                if (err) {
                    // Duplicate, resolve null to retry
                    resolve(null);
                } else {
                    resolve(token);
                }
            });
        });
    };

    (async () => {
        for (let i = 0; i < count; i++) {
            let token = null;
            let retries = 0;
            // Retry a few times if collision
            while (!token && retries < 5) {
                token = await insertToken();
                if (!token) retries++;
            }
            if (token) successfulTokens.push({ token, used: 0 });
        }
        res.json({ success: true, generated: successfulTokens });
    })();
});

// 2. Verify Token
app.get('/api/verify/:token', (req, res) => {
    const token = req.params.token;
    console.log(`[VERIFY] Request for: ${token} at ${new Date().toISOString()}`);

    db.get('SELECT * FROM tokens WHERE token = ?', [token], (err, row) => {
        if (err) {
            console.error(`[VERIFY] DB Error:`, err);
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            console.warn(`[VERIFY] Token NOT FOUND: ${token}`);
            return res.json({ valid: false, reason: 'not_found' });
        }
        if (row.used === 1) {
            console.warn(`[VERIFY] Token ALREADY USED: ${token}. Used at: ${row.used_at}`);
            return res.json({ valid: false, reason: 'used' });
        }
        console.log(`[VERIFY] Token VALID: ${token}`);
        res.json({ valid: true });
    });
});

// 3. Consume Token (After Verification/Signup)
app.post('/api/consume/:token', (req, res) => {
    const token = req.params.token;
    console.log(`[CONSUME] Request received for token: ${token} at ${new Date().toISOString()}`);

    // Set used=1 AND used_at timestamp
    db.run('UPDATE tokens SET used = 1, used_at = CURRENT_TIMESTAMP WHERE token = ? AND used = 0', [token], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            // Either token not found or already used
            db.get('SELECT used FROM tokens WHERE token = ?', [token], (err, row) => {
                if (!row) return res.status(404).json({ error: 'Token not found' });
                if (row.used === 1) return res.status(400).json({ error: 'Token already used' });
                return res.status(500).json({ error: 'Unknown failed to consume' });
            });
        } else {
            console.log(`[CONSUME] SUCCESS: ${token}`);
            res.json({ success: true, message: 'Token consumed' });
        }
    });
});

// 4. Analytics
app.get('/api/analytics', (req, res) => {
    const analytics = {};
    db.serialize(() => {
        // Stats
        db.get('SELECT COUNT(*) as total FROM tokens', (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            analytics.total = row.total;

            db.get('SELECT COUNT(*) as used FROM tokens WHERE used = 1', (err, row) => {
                if (err) return;
                analytics.used = row.used;
                analytics.unused = analytics.total - analytics.used;
                analytics.conversionRate = analytics.total > 0 ? ((analytics.used / analytics.total) * 100).toFixed(1) + '%' : '0%';

                // Recent Usage
                db.all('SELECT token, used_at FROM tokens WHERE used = 1 ORDER BY used_at DESC LIMIT 10', (err, rows) => {
                    if (err) return;
                    analytics.recent = rows;

                    // Latest Created (for UI)
                    db.all('SELECT token, created_at, used FROM tokens ORDER BY created_at DESC LIMIT 10', (err, rows) => {
                        if (err) return;
                        analytics.latest_tokens = rows;
                        res.json(analytics);
                    });
                });
            });
        });
    });
});

// 5. Reset System (Admin)
app.delete('/api/reset', (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM tokens');
        db.run('VACUUM'); // Reclaim space
        console.log('[RESET] System reset by admin');
        res.json({ success: true, message: 'System reset complete' });
    });
});

app.listen(PORT, () => {
    console.log(`Invite Service running on port ${PORT}`);
});
