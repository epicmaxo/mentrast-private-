const http = require('http');

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3001,
            path: '/api' + path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runTests() {
    console.log('--- Starting Invite Service Verification ---');

    // 1. Generate Token
    console.log('1. Generating Token...');
    const genRes = await request('POST', '/generate', { count: 1 });
    console.log('Response:', genRes);
    if (!genRes.success || !genRes.generated[0]) {
        console.error('FAILED: Generation');
        process.exit(1);
    }
    const token = genRes.generated[0];
    console.log('Got Token:', token);

    // 2. Verify Token (Should be valid)
    console.log('2. Verifying Token (Fresh)...');
    const verRes = await request('GET', `/verify/${token}`);
    console.log('Response:', verRes);
    if (!verRes.valid) {
        console.error('FAILED: Verification of fresh token');
        process.exit(1);
    }

    // 3. Consume Token
    console.log('3. Consuming Token...');
    const conRes = await request('POST', `/consume/${token}`);
    console.log('Response:', conRes);
    if (!conRes.success) {
        console.error('FAILED: Consumption');
        process.exit(1);
    }

    // 4. Verify Token Again (Should be invalid/used)
    console.log('4. Verifying Token (Used)...');
    const verRes2 = await request('GET', `/verify/${token}`);
    console.log('Response:', verRes2);
    if (verRes2.valid || verRes2.reason !== 'used') {
        console.error('FAILED: Verification of used token');
        process.exit(1);
    }

    // 5. Verify Invalid Token
    console.log('5. Verifying NON_EXISTENT Token...');
    const verRes3 = await request('GET', `/verify/NON_EXISTENT`);
    console.log('Response:', verRes3);
    if (verRes3.valid || verRes3.reason !== 'not_found') {
        console.error('FAILED: Verification of invalid token');
        process.exit(1);
    }

    console.log('--- ALL TESTS PASSED ---');
}

runTests().catch(console.error);
