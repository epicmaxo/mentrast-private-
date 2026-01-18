const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || __dirname;

// Ensure Data Directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware
app.use(cors()); // In production, restrict this to ['https://your-main-app.com'] via env var
app.use(express.json());
app.use(express.static('public'));

// Database Setup
const dbPath = path.join(DATA_DIR, 'tokens.db');
console.log(`Database path: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

function initDb() {
    db.run(`CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

// Token Generation Helper
function generateRandomToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';
    const length = 7; // Rules say 6-8. Picking 7 as sweet spot.
    for (let i = 0; i < length; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

// API Endpoints

// 1. Generate Tokens
app.post('/api/generate', (req, res) => {
    const count = parseInt(req.body.count) || 1;
    const maxRetries = 10;
    const successfulTokens = [];
    const errors = [];

    let completed = 0;

    // Logic to insert N tokens
    // We do them sequentially or parallel, but for SQLite simple loop is fine.
    // Handling async in loop for SQLite requires care or promises.
    // Let's use a recursive approach or simple Promise wrapper around db.run

    const insertToken = async () => {
        let retries = 0;
        let inserted = false;
        let token = '';

        while (!inserted && retries < maxRetries) {
            token = generateRandomToken();
            try {
                await new Promise((resolve, reject) => {
                    db.run('INSERT INTO tokens (token) VALUES (?)', [token], function (err) {
                        if (err) {
                            if (err.message.includes('UNIQUE constraint failed')) {
                                resolve(false); // Collision, try again
                            } else {
                                reject(err);
                            }
                        } else {
                            resolve(true);
                        }
                    });
                }).then(success => {
                    if (success) inserted = true;
                    else retries++;
                });
            } catch (e) {
                console.error('DB Error:', e);
                break;
            }
        }

        if (inserted) return token;
        return null;
    };

    // Execute generation
    (async () => {
        for (let i = 0; i < count; i++) {
            const token = await insertToken();
            if (token) successfulTokens.push(token);
        }
        res.json({
            success: true,
            generated: successfulTokens,
            count: successfulTokens.length
        });
    })();
});

// 2. Verify Token
app.get('/api/verify/:token', (req, res) => {
    const token = req.params.token;
    db.get('SELECT * FROM tokens WHERE token = ?', [token], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.json({ valid: false, reason: 'not_found' });
        }
        if (row.used === 1) {
            return res.json({ valid: false, reason: 'used' });
        }
        res.json({ valid: true });
    });
});

// 3. Consume Token
app.post('/api/consume/:token', (req, res) => {
    const token = req.params.token;

    // First verify to prevent race condition double-use if possible, 
    // but SQL UPDATE ... WHERE used=0 is safer.

    db.run('UPDATE tokens SET used = 1 WHERE token = ? AND used = 0', [token], function (err) {
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
            res.json({ success: true, message: 'Token consumed' });
        }
    });
});

app.listen(PORT, () => {
    console.log(`Invite Service running on port ${PORT}`);
});
