/**
 * End-to-end test for the Google AI Studio / Vertex AI header passthrough patch.
 *
 * It boots the real SillyTavern chat-completions router, points the Google AI Studio
 * source at a local stand-in server, and asserts which headers actually reach the upstream.
 *
 * Usage (from anywhere):
 *   node st-patch/test-opencode-google-headers.mjs <SillyTavern-root>
 *
 * Requires the patch to be installed first:
 *   node st-patch/install.mjs
 *
 * @module st-patch/test-opencode-google-headers
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const stRoot = path.resolve(process.argv[2] || process.cwd());
const require = createRequire(path.join(stRoot, 'package.json'));
const express = require('express');

// The router logs every request/response to the console; silence it so the results below stay
// readable. Use `out()` instead of console.log from this point on.
for (const method of ['debug', 'info', 'log', 'warn']) {
    console[method] = () => {};
}

/**
 * Writes a line to stdout, bypassing the silenced console.
 * @param {string} line Text to write
 * @returns {void}
 */
function out(line) {
    process.stdout.write(`${line}\n`);
}

const results = [];

/**
 * Records a check result.
 * @param {string} name Check name
 * @param {*} actual Actual value
 * @param {*} expected Expected value
 */
function check(name, actual, expected) {
    const ok = actual === expected;
    results.push({ name, ok, actual, expected });
}

/**
 * Records a check that does not apply to this SillyTavern version.
 * @param {string} name Check name
 * @param {string} reason Why the check was skipped
 */
function skip(name, reason) {
    results.push({ name, ok: true, skipped: true, reason });
}

const backendPath = path.join(stRoot, 'src', 'endpoints', 'backends', 'chat-completions.js');
const backendSource = fs.readFileSync(backendPath, 'utf8');
// Vertex AI only exists in newer SillyTavern releases.
const supportsVertexAi = /VERTEXAI|'vertexai'/i.test(backendSource);
const { router } = await import(pathToFileURL(backendPath).href);

// Upstream stand-in for the Google AI Studio API.
const captured = [];
const upstream = http.createServer((req, res) => {
    captured.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

// SillyTavern API with the real chat completions router mounted.
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    req.user = { directories: { root: path.join(stRoot, 'data', 'default-user'), user: 'default-user' } };
    next();
});
app.use('/api/backends/chat-completions', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}/api/backends/chat-completions`;

/**
 * Posts a request to the SillyTavern API and returns what the upstream received.
 * @param {string} route Route name
 * @param {object} body Request body
 * @returns {Promise<{url?: string, headers?: Record<string, string>}>} Captured upstream request
 */
async function post(route, body) {
    captured.length = 0;
    const response = await fetch(`${apiUrl}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    await response.text().catch(() => null);
    return captured[0] ?? {};
}

const baseBody = {
    chat_completion_source: 'makersuite',
    reverse_proxy: upstreamUrl,
    proxy_password: 'fake-key',
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
    stream: false,
};

// 1. Headers supplied by the extension must reach the upstream.
let request = await post('generate', {
    ...baseBody,
    open_code_headers: '- x-opencode-session: ses_test123456\n- user-agent: opencode/latest/2.0.6/cli\n- x-opencode-client: cli',
});
check('upstream receives x-opencode-session', request.headers?.['x-opencode-session'], 'ses_test123456');
check('upstream receives the opencode user agent', request.headers?.['user-agent'], 'opencode/latest/2.0.6/cli');
check('upstream receives x-opencode-client', request.headers?.['x-opencode-client'], 'cli');
check('default content type is preserved', request.headers?.['content-type'], 'application/json');
check('request hits the Gemini generateContent endpoint', request.url?.startsWith('/v1beta/models/gemini-2.0-flash:generateContent'), true);
check('api key stays in the query string', request.url?.includes('key=fake-key'), true);

// 2. Regression: without open_code_headers nothing extra is forwarded.
request = await post('generate', baseBody);
check('no session header when the client sends none', request.headers?.['x-opencode-session'], undefined);
check('content type still present', request.headers?.['content-type'], 'application/json');

// 3. Regression: malformed YAML must not break the request.
request = await post('generate', { ...baseBody, open_code_headers: 'not: [valid' });
check('malformed yaml is ignored, request still succeeds', request.headers?.['content-type'], 'application/json');

// 4. Vertex AI source uses the same code path (only on SillyTavern versions that have it).
if (supportsVertexAi) {
    request = await post('generate', {
        ...baseBody,
        chat_completion_source: 'vertexai',
        open_code_headers: '- x-opencode-session: ses_vertex1234',
    });
    check('vertexai source also forwards the session header', request.headers?.['x-opencode-session'], 'ses_vertex1234');
} else {
    skip('vertexai source also forwards the session header', 'this SillyTavern version has no Vertex AI chat completion source');
}

server.close();
upstream.close();

for (const result of results) {
    if (result.skipped) {
        out(`SKIP  ${result.name} (${result.reason})`);
        continue;
    }
    const detail = result.ok ? '' : ` (expected: ${JSON.stringify(result.expected)}, actual: ${JSON.stringify(result.actual)})`;
    out(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${detail}`);
}

const failed = results.filter(x => !x.ok).length;
out(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed > 0 ? 1 : 0;
