#!/usr/bin/env node
/**
 * Applies / removes the Google AI Studio & Vertex AI header passthrough patch.
 *
 * SillyTavern builds the upstream headers for Google AI Studio / Vertex AI requests in
 * sendMakerSuiteRequest() and hard-codes them to `Content-Type` only (the API key travels
 * as a `?key=` query parameter). A client-side extension therefore cannot inject anything
 * into those requests. This installer adds a single merge point that forwards the headers
 * the client sends in the `open_code_headers` body field.
 *
 * Run from the SillyTavern root directory:
 *   node st-patch/install.mjs                 apply (idempotent)
 *   node st-patch/install.mjs --check         only report the current state
 *   node st-patch/install.mjs --revert        remove the patch
 *   node st-patch/install.mjs --file <path>   operate on a specific copy of the file
 *
 * @module st-patch/install
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TARGET = path.join('src', 'endpoints', 'backends', 'chat-completions.js');
const BEGIN = '/* BEGIN ocgo-google-headers */';
const END = '/* END ocgo-google-headers */';
const CALL = 'headers: getMakerSuiteHeaders(request)';
const KEY_MARKER = '?key=${apiKey}';
const DOC_ANCHOR = 'Sends a request to Google AI API.';
const FN_ANCHOR = 'async function sendMakerSuiteRequest(';
const HEADERS_RE = /headers:\s*\{\s*'Content-Type':\s*'application\/json',?\s*\}/;
// The trailing comma and the CR of a CRLF line ending must not be consumed by the match.
const CALL_RE = /^([ \t]*)headers: getMakerSuiteHeaders\(request\),?[ \t]*(?=\r?$)/m;

/**
 * Reports an error and exits.
 * @param {string} message Error message
 * @returns {never} Never returns
 */
function fail(message) {
    console.error(`[ocgo] ${message}`);
    process.exit(1);
}

/**
 * Builds the injected helper function source.
 * @param {string} eol Line ending to use
 * @returns {string} Helper source, terminated by a line ending
 */
function helperSource(eol) {
    return [
        BEGIN,
        '/**',
        ' * Builds the upstream headers for Google AI Studio / Vertex AI requests.',
        ' * Headers supplied by the client in `open_code_headers` (YAML) are merged on top of the',
        ' * defaults, so protocol-level headers (e.g. OpenCode session headers) can be forwarded.',
        ' * @param {express.Request} request Express request',
        ' * @returns {Record<string, string>} Headers for the upstream request',
        ' */',
        'function getMakerSuiteHeaders(request) {',
        "    const headers = { 'Content-Type': 'application/json' };",
        '',
        "    if (typeof request.body.open_code_headers === 'string' && request.body.open_code_headers.trim()) {",
        '        mergeObjectWithYaml(headers, request.body.open_code_headers);',
        '    }',
        '',
        '    return headers;',
        '}',
        END,
        '',
    ].join(eol);
}

const args = process.argv.slice(2);
const mode = args.includes('--revert') ? 'revert' : (args.includes('--check') ? 'check' : 'apply');
const fileIndex = args.indexOf('--file');
const target = fileIndex >= 0 && args[fileIndex + 1] ? args[fileIndex + 1] : DEFAULT_TARGET;

if (!fs.existsSync(target)) {
    fail(`Target not found: ${target}\n[ocgo] Run this script from the SillyTavern root directory.`);
}

const original = fs.readFileSync(target, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const isPatched = original.includes(BEGIN);

if (mode === 'check') {
    console.log(`[ocgo] file : ${target}`);
    console.log(`[ocgo] state: ${isPatched ? 'PATCHED' : 'NOT PATCHED'}`);
    process.exit(isPatched ? 0 : 2);
}

if (mode === 'apply' && isPatched) {
    console.log('[ocgo] Already patched, nothing to do.');
    process.exit(0);
}

if (mode === 'revert' && !isPatched) {
    console.log('[ocgo] Not patched, nothing to revert.');
    process.exit(0);
}

let source = original;

if (mode === 'apply') {
    if (!/\bmergeObjectWithYaml\b/.test(source)) {
        fail('mergeObjectWithYaml is not present in this file - unsupported SillyTavern version.');
    }

    const keyIndex = source.indexOf(KEY_MARKER);
    if (keyIndex < 0) {
        fail('Could not locate the Google AI Studio fetch call (missing `?key=${apiKey}`).');
    }

    const window = source.slice(keyIndex, keyIndex + 600);
    if (!HEADERS_RE.test(window)) {
        fail('Could not locate the hard-coded headers object inside sendMakerSuiteRequest().');
    }

    source = source.slice(0, keyIndex) + window.replace(HEADERS_RE, CALL) + source.slice(keyIndex + 600);

    const docIndex = source.indexOf(DOC_ANCHOR);
    const fnIndex = source.indexOf(FN_ANCHOR);
    const insertAt = docIndex >= 0 ? source.lastIndexOf('/**', docIndex) : fnIndex;
    if (insertAt < 0) {
        fail('Could not locate sendMakerSuiteRequest() for helper insertion.');
    }

    source = source.slice(0, insertAt) + helperSource(eol) + source.slice(insertAt);
} else {
    source = source.replace(CALL_RE, (_match, indent) => [
        `${indent}headers: {`,
        `${indent}    'Content-Type': 'application/json',`,
        `${indent}},`,
    ].join(eol));

    const beginIndex = source.indexOf(BEGIN);
    const endIndex = source.indexOf(END);
    if (beginIndex < 0 || endIndex < beginIndex) {
        fail('Patch markers not found - the file may have been modified manually.');
    }

    let removeEnd = endIndex + END.length;
    if (source.startsWith(eol, removeEnd)) {
        removeEnd += eol.length;
    }

    source = source.slice(0, beginIndex) + source.slice(removeEnd);
}

fs.writeFileSync(target, source, 'utf8');
console.log(`[ocgo] ${mode === 'apply' ? 'Patched' : 'Reverted'}: ${target}`);
console.log('[ocgo] Restart SillyTavern for the change to take effect.');
