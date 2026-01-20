require('dotenv').config();
const dns = require('dns');
// Force IPv4 because Render/Supabase interaction often fails on IPv6
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

// Global Error Handlers to prevent crash
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    // Keep running if possible, or restart gracefully
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
const PORT = process.env.PORT || 3001;


// Database Connection
const connectionString = process.env.DATABASE_URL;

let pool;

async function initializePool() {
    if (!connectionString) {
        console.error("⛔ CRITICAL: DATABASE_URL is missing. Please set it in Render Dashboard -> Environment.");
        return;
    }

    try {
        // HACK: Force IPv4 by resolving hostname manually
        // Render sometimes forces IPv6 which fails with Supabase
        const url = new URL(connectionString);
        const host = url.hostname;

        console.log(`[DNS] Resolving ${host} to IPv4...`);
        const addresses = await dns.promises.resolve4(host);

        if (addresses && addresses.length > 0) {
            console.log(`[DNS] Resolved to ${addresses[0]}`);
            url.hostname = addresses[0]; // Replace host with IP

            pool = new Pool({
                connectionString: url.toString(),
                ssl: {
                    rejectUnauthorized: false,
                    servername: host // SNI requires original hostname
                }
            });
            console.log('[DB] Pool initialized with IPv4');
        } else {
            throw new Error('No IPv4 addresses found');
        }
    } catch (e) {
        console.error("Failed to resolve/initialize DB:", e);
        // Fallback to original string if DNS fails
        pool = new Pool({
            connectionString: connectionString,
            ssl: { rejectUnauthorized: false }
        });
    }
}

initializePool();

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: pool ? 'init' : 'missing' });
});

// Initialize DB Table
const initDB = async () => {
    try {
        const client = await pool.connect();
        try {
            console.log('Connected to PostgreSQL successfully.');
            await client.query(`
                CREATE TABLE IF NOT EXISTS tokens (
                    token TEXT PRIMARY KEY,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    used INTEGER DEFAULT 0,
                    used_at TIMESTAMP
                );
            `);
            console.log('Database schema verified.');
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('CRITICAL DATABASE ERROR:', err);
    }
};

initDB();

app.use(express.json());
app.use(express.static('public'));

// CORS Configuration
const allowedOrigins = [
    'https://mentrastchat.vercel.app',
    'http://localhost:3000',
    'https://mentrast-lp.vercel.app',
    'https://mentrast-private.onrender.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// Helper to check DB status
const ensureDB = (req, res, next) => {
    if (!pool) {
        return res.status(503).json({ error: 'Database is initializing or failed to connect. Check server logs.' });
    }
    next();
};

function generateToken() {
    return crypto.randomBytes(4).toString('hex').slice(0, 7).toUpperCase();
}

// 1. Generate Tokens (Admin)
app.post('/api/generate', ensureDB, async (req, res) => {
    const count = req.body.count || 1;
    const successfulTokens = [];

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
                } catch (e) {
                    // Unique constraint violation usually code '23505'
                    retries++;
                }
            }
            if (token) successfulTokens.push({ token, used: 0 });
        }
        res.json({ success: true, generated: successfulTokens });
    } catch (e) {
        console.error("Generate Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 2. Verify Token
app.get('/api/verify/:token', ensureDB, async (req, res) => {
    const token = req.params.token;
    console.log(`[VERIFY] Request for: ${token} at ${new Date().toISOString()}`);

    try {
        const { rows } = await pool.query('SELECT * FROM tokens WHERE token = $1', [token]);

        if (rows.length === 0) {
            console.warn(`[VERIFY] Token NOT FOUND: ${token}`);
            return res.json({ valid: false, reason: 'not_found' });
        }

        const row = rows[0];
        if (row.used === 1) {
            console.warn(`[VERIFY] Token ALREADY USED: ${token}. Used at: ${row.used_at}`);
            return res.json({ valid: false, reason: 'used' });
        }

        console.log(`[VERIFY] Token VALID: ${token}`);
        res.json({ valid: true });

    } catch (err) {
        console.error(`[VERIFY] DB Error:`, err);
        return res.status(500).json({ error: err.message });
    }
});

// 3. Consume Token
app.post('/api/consume/:token', ensureDB, async (req, res) => {
    const token = req.params.token;
    console.log(`[CONSUME] Request received for token: ${token} at ${new Date().toISOString()}`);

    try {
        // UPDATE ... RETURNING * is a nice Postgres feature we could use, but keeping logic similar for now
        const result = await pool.query(
            'UPDATE tokens SET used = 1, used_at = CURRENT_TIMESTAMP WHERE token = $1 AND used = 0',
            [token]
        );

        if (result.rowCount === 0) {
            // Check why it failed
            const { rows } = await pool.query('SELECT used FROM tokens WHERE token = $1', [token]);
            if (rows.length === 0) return res.status(404).json({ error: 'Token not found' });
            if (rows[0].used === 1) return res.status(400).json({ error: 'Token already used' });
            return res.status(500).json({ error: 'Unknown failed to consume' });
        }

        console.log(`[CONSUME] SUCCESS: ${token}`);
        res.json({ success: true, message: 'Token consumed' });

    } catch (err) {
        console.error("Consume Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 4. Analytics
app.get('/api/analytics', ensureDB, async (req, res) => {
    try {
        const totalParams = await pool.query('SELECT COUNT(*) as count FROM tokens');
        const usedParams = await pool.query('SELECT COUNT(*) as count FROM tokens WHERE used = 1');

        const total = parseInt(totalParams.rows[0].count);
        const used = parseInt(usedParams.rows[0].count);
        const unused = total - used;
        const conversionRate = total > 0 ? ((used / total) * 100).toFixed(1) + '%' : '0%';

        const recent = await pool.query('SELECT token, used_at FROM tokens WHERE used = 1 ORDER BY used_at DESC LIMIT 10');
        const latest = await pool.query('SELECT token, created_at, used FROM tokens ORDER BY created_at DESC LIMIT 10');

        res.json({
            total,
            used,
            unused,
            conversionRate,
            recent: recent.rows,
            latest_tokens: latest.rows
        });

    } catch (e) {
        console.error("Analytics Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 5. Reset System (Admin Only)
app.delete('/api/reset', ensureDB, async (req, res) => {
    try {
        await pool.query('DELETE FROM tokens');
        // VACUUM is handled automatically by Postgres generally, but full vacuum can't be run inside trans block usually.
        // DELETE is enough.
        console.log('[RESET] System reset by admin');
        res.json({ success: true, message: 'System reset complete' });
    } catch (e) {
        console.error("Reset Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Invite Service running on port ${PORT}`);
});
