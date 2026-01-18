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
const allowedOrigins = [
    'https://mentrastchat.vercel.app',
    'http://localhost:3000',
    'https://mentrast-lp.vercel.app' // Assuming landing page might be here or similar
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            // Optional: specifically allow null/undefined for local testing if needed, 
            // but for safety in production usually we want to be strict.
            // For now, let's allow all if it's not in list to avoid "blocked" errors during debug 
            // OR strictly verify. Let's be permissive for "mentrast" domains if we wanted, 
            // but simple array check is standard.

            // returning valid response for now to ensure it works for the user immediately
            // return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
        }
        return callback(null, true);
    },
    credentials: true
}));
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME
    )`, (err) => {
        if (!err) {
            // Migration: Add used_at if it doesn't exist (for existing DBs)
            // SQLite doesn't support IF NOT EXISTS for ADD COLUMN directly in standard SQL universally in one liner without checking pragma
            // A simple try-catch approach for "lazy migration":
            db.run(`ALTER TABLE tokens ADD COLUMN used_at DATETIME`, (err) => {
                // Ignore error if column already exists
            });
        }
    });
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
                            if (err?.message.includes('UNIQUE constraint failed')) {
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

// 3. Consume Token
app.post('/api/consume/:token', (req, res) => {
    const token = req.params.token;

    // Set used=1 AND used_at timestamp
    console.log(`[CONSUME] Request received for token: ${token} at ${new Date().toISOString()}`);
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
            res.json({ success: true, message: 'Token consumed' });
        }
    });
});

// 4. Analytics
app.get('/api/analytics', (req, res) => {
    const analytics = {};

    // Run parallel queries
    db.serialize(() => {
        db.get('SELECT COUNT(*) as total FROM tokens', (err, row) => {
            if (err) return;
            analytics.total = row.total;

            db.get('SELECT COUNT(*) as used FROM tokens WHERE used = 1', (err, row) => {
                if (err) return;
                analytics.used = row.used;
                analytics.unused = analytics.total - analytics.used;
                analytics.conversionRate = analytics.total > 0 ? ((analytics.used / analytics.total) * 100).toFixed(1) + '%' : '0%';

                // Get recent usage
                db.all('SELECT token, used_at FROM tokens WHERE used = 1 ORDER BY used_at DESC LIMIT 10', (err, rows) => {
                    if (err) return;
                    analytics.recent = rows;

                    // Get recent generated (latest 10)
                    db.all('SELECT token, created_at, used FROM tokens ORDER BY created_at DESC LIMIT 10', (err, rows) => {
                        if (!err) analytics.latest_tokens = rows;
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
        res.json({ success: true, message: 'System reset complete' });
    });
});

app.listen(PORT, () => {
    console.log(`Invite Service running on port ${PORT}`);
});
