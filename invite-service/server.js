require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

// Global Error Handlers
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

const app = express();
const PORT = process.env.PORT || 3001;
const connectionString = process.env.DATABASE_URL;

let pool;

// CORS Configuration
const allowedOrigins = [
    'https://mentrastchat.vercel.app',
    'http://localhost:3000',
    'https://mentrast-lp.vercel.app',
    'https://mentrast-private.onrender.com',
    'https://mentrast.com',
    'https://www.mentrast.com',
    'https://app.mentrast.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('CORS Policy Block'), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static('public'));

// Middleware: Guard endpoints if DB is not ready
const ensureDB = (req, res, next) => {
    if (!pool) {
        return res.status(503).json({ error: 'Database disconnected. Check server logs.' });
    }
    next();
};

function generateToken() {
    return crypto.randomBytes(4).toString('hex').slice(0, 7).toUpperCase();
}

// ----------------------------------------------------
// API ENDPOINTS
// ----------------------------------------------------

// Root Endpoint (for easy availability check)
app.get('/', (req, res) => {
    res.json({
        service: 'Mentrast Invite Service',
        status: 'running',
        db: pool ? 'connected' : 'disconnected'
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: pool ? 'connected' : 'disconnected' });
});

// 1. Generate Tokens
app.post('/api/generate', ensureDB, async (req, res) => {
    const count = req.body.count || 1;
    const successfulTokens = [];
    try {
        const client = await pool.connect();
        try {
            for (let i = 0; i < count; i++) {
                let token = null;
                let retries = 0;
                while (!token && retries < 5) {
                    const candidate = generateToken();
                    try {
                        await client.query('INSERT INTO tokens (token) VALUES ($1)', [candidate]);
                        token = candidate;
                    } catch (e) { retries++; }
                }
                if (token) successfulTokens.push({ token, used: 0 });
            }
            res.json({ success: true, generated: successfulTokens });
        } finally { client.release(); }
    } catch (e) {
        console.error("Generate Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Verify Token
app.get('/api/verify/:token', ensureDB, async (req, res) => {
    const token = req.params.token;
    console.log(`[VERIFY] Request for: ${token}`);
    try {
        const { rows } = await pool.query('SELECT * FROM tokens WHERE token = $1', [token]);
        if (rows.length === 0) return res.json({ valid: false, reason: 'not_found' });

        const row = rows[0];
        if (row.used === 1) return res.json({ valid: false, reason: 'used' });

        res.json({ valid: true });
    } catch (err) {
        console.error(`[VERIFY] DB Error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Consume Token
app.post('/api/consume/:token', ensureDB, async (req, res) => {
    const token = req.params.token;
    const email = req.body.email || 'unknown'; // Track who used it
    const provider = req.body.provider || 'unknown';

    // Get IP (Render/Express proxy safe)
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    console.log(`[CONSUME] Request: ${token} by ${email} (${provider}) IP: ${ip}`);
    try {
        const result = await pool.query(
            'UPDATE tokens SET used = 1, used_at = CURRENT_TIMESTAMP, activated_by = $2, auth_provider = $3, ip_address = $4 WHERE token = $1 AND used = 0',
            [token, email, provider, ip]
        );
        if (result.rowCount === 0) {
            const { rows } = await pool.query('SELECT used FROM tokens WHERE token = $1', [token]);
            if (rows.length === 0) return res.status(404).json({ error: 'Token not found' });
            if (rows[0].used === 1) return res.status(400).json({ error: 'Token already used' });
            return res.status(500).json({ error: 'Unknown failed' });
        }
        res.json({ success: true, message: 'Token consumed' });
    } catch (err) {
        console.error("Consume Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Analytics
app.get('/api/analytics', ensureDB, async (req, res) => {
    try {
        const totalRes = await pool.query('SELECT COUNT(*) as count FROM tokens');
        const usedRes = await pool.query('SELECT COUNT(*) as count FROM tokens WHERE used = 1');
        const recentRes = await pool.query('SELECT token, used_at, recipient_name, activated_by, auth_provider, ip_address FROM tokens WHERE used = 1 ORDER BY used_at DESC LIMIT 10');
        const latestRes = await pool.query('SELECT token, created_at, used, recipient_name FROM tokens ORDER BY created_at DESC LIMIT 10');

        const total = parseInt(totalRes.rows[0].count);
        const used = parseInt(usedRes.rows[0].count);
        const conversionRate = total > 0 ? ((used / total) * 100).toFixed(1) + '%' : '0%';

        res.json({
            total,
            used,
            unused: total - used,
            conversionRate,
            recent: recentRes.rows,
            latest_tokens: latestRes.rows
        });
    } catch (e) {
        console.error("Analytics Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 5. Reset
app.delete('/api/reset', ensureDB, async (req, res) => {
    try {
        await pool.query('DELETE FROM tokens');
        console.log('[RESET] System reset');
        res.json({ success: true, message: 'System reset complete' });
    } catch (e) {
        console.error("Reset Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ----------------------------------------------------
// SERVER STARTUP SEQUENCE
// ----------------------------------------------------

// Vercel Serverless Function Handler
if (process.env.VERCEL) {
    // In Vercel, we need to ensure the DB connection is established for every request checks
    // However, for "serverless", we typically don't start a persistent listener.
    // The "app" export is handled by @vercel/node. 
    // We just need to make sure "pool" is initialized.

    if (connectionString) {
        pool = new Pool({
            connectionString: connectionString,
            ssl: { rejectUnauthorized: false }
        });
    }
} else {
    // Local Development / Render persistent server
    async function startServer() {
        if (!connectionString) {
            console.error("⛔ CRITICAL: DATABASE_URL is missing. Please set it in Render Dashboard.");
            return;
        }

        try {
            console.log("[DB] Connecting to PostgreSQL (Pooler Mode)...");

            // Disable SSL verification for simple connection to Pooler
            pool = new Pool({
                connectionString: connectionString,
                ssl: { rejectUnauthorized: false }
            });

            // Test connection & Init Table
            const client = await pool.connect();
            try {
                console.log("✅ [DB] Connected successfully.");
                await client.query(`
                    CREATE TABLE IF NOT EXISTS tokens (
                        token TEXT PRIMARY KEY,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        used INTEGER DEFAULT 0,
                        used_at TIMESTAMP,
                        recipient_name TEXT
                    );
                `);
                // Attempt to add column if it doesn't exist (Migration logic)
                try {
                    await client.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS recipient_name TEXT;`);
                    await client.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS activated_by TEXT;`);
                    await client.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS auth_provider TEXT;`);
                    await client.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS ip_address TEXT;`);
                } catch (e) {
                    console.log("[DB] Columns check skipped or failed (likely already exists or not needed).");
                }

                console.log("✅ [DB] Schema verified.");
            } finally {
                client.release();
            }

            // Only start listener if DB is ready
            app.listen(PORT, () => {
                console.log(`✅ Invite Service running on port ${PORT}`);
            });

        } catch (e) {
            console.error("❌ [DB] FATAL CONNECTION ERROR:", e.message);
            console.error("   Ensure you are using the Transaction Pooler URL (port 6543).");
            // Start anyway to serve logs, pool is null
            app.listen(PORT, () => console.log(`⚠️ Service running on ${PORT} (DB Disconnected mode)`));
        }
    }

    startServer();
}

module.exports = app;
