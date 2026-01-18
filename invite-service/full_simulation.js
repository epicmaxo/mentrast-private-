const http = require('http');

const API_HOST = 'localhost';
const API_PORT = 3001;

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: API_HOST,
            port: API_PORT,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    console.log("Raw response:", data);
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runTest() {
    console.log("--- STARTING FULL SYSTEM VERIFICATION ---");

    // 1. RESET
    console.log("\n1. [TEST] System Reset...");
    try {
        const resetRes = await request('DELETE', '/api/reset');
        if (resetRes.success) console.log("   ✅ Reset Successful");
        else throw new Error("Reset failed");
    } catch (e) { console.error("   ❌ Reset Error:", e.message); return; }

    // 2. GENERATE
    console.log("\n2. [TEST] Generating Token...");
    let token;
    try {
        const genRes = await request('POST', '/api/generate', { count: 1 });
        if (genRes.success && genRes.generated.length > 0) {
            token = genRes.generated[0].token;
            console.log(`   ✅ Generated Token: ${token}`);
        } else throw new Error("Generation failed");
    } catch (e) { console.error("   ❌ Generation Error:", e.message); return; }

    // 3. VERIFY (Should be Valid)
    console.log(`\n3. [TEST] Verifying ${token} (Read-Only)...`);
    try {
        const verifyRes = await request('GET', `/api/verify/${token}`);
        if (verifyRes.valid === true) console.log("   ✅ Token is VALID (Correct)");
        else console.error(`   ❌ Token is INVALID (Expected Valid). Reason: ${verifyRes.reason}`);
    } catch (e) { console.error("   ❌ Verify Error:", e.message); return; }

    // 4. CONSUME (Should Succeed)
    console.log(`\n4. [TEST] Consuming ${token} (Simulating Signup)...`);
    try {
        const consumeRes = await request('POST', `/api/consume/${token}`);
        if (consumeRes.success) console.log("   ✅ Consumption Successful");
        else console.error("   ❌ Consumption Failed");
    } catch (e) { console.error("   ❌ Consume Error:", e.message); return; }

    // 5. VERIFY AGAIN (Should be Invalid)
    console.log(`\n5. [TEST] Verifying ${token} AGAIN (Should be used)...`);
    try {
        const reVerifyRes = await request('GET', `/api/verify/${token}`);
        if (reVerifyRes.valid === false && reVerifyRes.reason === 'used') {
            console.log("   ✅ Token is now INVALID/USED (Correct)");
        } else {
            console.error(`   ❌ Unexpected verification result: ${JSON.stringify(reVerifyRes)}`);
        }
    } catch (e) { console.error("   ❌ Re-Verify Error:", e.message); return; }

    console.log("\n--- VERIFICATION COMPLETE: SYSTEM IS HEALTHY ---");
}

runTest();
