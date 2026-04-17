import { Actor, log } from 'apify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com']);

function extractVideoId(url) {
    try {
        const u = new URL(url);
        if (!YT_HOSTS.has(u.hostname)) return null;
        if (u.hostname === 'youtu.be') return u.pathname.replace('/', '').slice(0, 11) || null;
        if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2]?.slice(0, 11) || null;
        if (u.pathname === '/watch') return u.searchParams.get('v')?.slice(0, 11) || null;
        return null;
    } catch {
        return null;
    }
}

function canonicalWatchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizePreferredLanguage(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.filter(Boolean);
    if (typeof input === 'string') return [input];
    return [];
}

function decodeHtmlEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/\u2028/g, ' ')
        .replace(/\u2029/g, ' ');
}

function normalizeText(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;!?])/g, '$1')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function cleanSegmentText(text, { removeBrackets = true }) {
    let t = String(text || '').trim();
    if (removeBrackets) t = t.replace(/\[[^\]]+\]/g, '').trim();
    // Remove ALL-CAPS speaker labels like "SPEAKER:" or "JOHN DOE:"
    t = t.replace(/^([A-Z][A-Z0-9 ]{2,}):\s+/, '');
    return normalizeText(t);
}

function parseTimestamp(ts) {
    const m = ts.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const [_, h, min, sec] = m;
    return Number(h) * 3600 + Number(min) * 60 + Number(sec);
}

function parseVtt(vttContent, { removeBrackets = true }) {
    const lines = vttContent.split(/\r?\n/);
    const segments = [];
    let current = [];
    let startSec = null;
    let endSec = null;

    const flush = () => {
        if (!current.length) return;
        const raw = current.join(' ');
        const decoded = decodeHtmlEntities(raw.replace(/<[^>]*>/g, ' '));
        const cleaned = cleanSegmentText(decoded, { removeBrackets });
        if (cleaned) {
            segments.push({
                startSec,
                durSec: startSec != null && endSec != null ? Math.max(0, endSec - startSec) : null,
                text: cleaned,
            });
        }
        current = [];
        startSec = null;
        endSec = null;
    };

    for (const line of lines) {
        const l = line.trim();
        if (!l || l.startsWith('WEBVTT') || l.startsWith('Kind:') || l.startsWith('Language:')) continue;
        if (l.includes('-->')) {
            flush();
            const [start, end] = l.split('-->').map((s) => s.trim());
            startSec = parseTimestamp(start);
            endSec = parseTimestamp(end);
            continue;
        }
        current.push(l);
    }
    flush();
    return segments;
}

function dedupeSegments(segments) {
    const seen = new Set();
    const out = [];
    for (const s of segments) {
        if (!s.text) continue;
        if (seen.has(s.text)) continue;
        seen.add(s.text);
        out.push(s);
    }
    return out;
}

function buildTranscriptText(segments, joinWith = 'space') {
    const sep = joinWith === 'newline' ? '\n' : ' ';
    return segments.map((s) => s.text).join(sep).replace(/\s+\n/g, '\n').trim();
}

function normalizeBlockedReason(stderr = '') {
    const s = stderr.toLowerCase();
    if (s.includes('429') || s.includes('too many requests')) return '429';
    if (s.includes('captcha')) return 'captcha';
    if (s.includes('sign in to confirm') || s.includes('sign in')) return 'signin_required';
    if (s.includes('consent') && s.includes('loop')) return 'consent_loop';
    return 'unknown';
}

function sanitizeProxyArg(arg) {
    return arg.replace(/(https?:\/\/)([^:@]+):([^@]+)@/i, '$1***:***@');
}

function sanitizeCommand(args) {
    const out = [...args];
    const proxyIdx = out.findIndex((a) => a === '--proxy');
    if (proxyIdx >= 0 && out[proxyIdx + 1]) {
        out[proxyIdx + 1] = sanitizeProxyArg(out[proxyIdx + 1]);
    }
    return out;
}

async function runYtDlp(args, { proxyUrl, timeoutMs, debug, proxyInjected }) {
    const finalArgs = [...args];
    if (proxyUrl) finalArgs.push('--proxy', proxyUrl);
    if (debug) {
        const sanitized = sanitizeCommand(finalArgs);
        log.info(`yt-dlp cmd: yt-dlp ${sanitized.join(' ')}`);
        log.info(`proxyInjected=${proxyInjected}`);
    }
    try {
        const { stdout, stderr } = await execFileAsync('yt-dlp', finalArgs, {
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr };
    } catch (err) {
        const stderr = err?.stderr || '';
        if (debug && stderr) {
            const lines = stderr.split(/\r?\n/).slice(0, 15).join('\n');
            log.info(`yt-dlp stderr (first 15 lines):\n${lines}`);
        }
        throw err;
    }
}

// Single yt-dlp call: downloads manual+auto subs and fetches metadata via --print.
// Eliminates the separate --list-subs roundtrip and three individual metadata calls.
async function downloadSubtitlesWithMeta({ url, outputTemplate, subLangs, proxyUrl, timeoutMs, debug, proxyInjected }) {
    const args = [
        '--write-sub',
        '--write-auto-sub',
        '--skip-download',
        '--sub-format', 'vtt',
        '--sub-langs', subLangs.join(','),
        '--no-playlist',
        '--print', '%(title)s|||%(uploader)s|||%(duration)s',
        '--output', outputTemplate,
        url,
    ];
    const { stdout, stderr } = await runYtDlp(args, { proxyUrl, timeoutMs, debug, proxyInjected });

    // yt-dlp writes info messages to stderr
    const infoOutput = stderr || '';
    let subtitleType = 'auto';
    let source = 'yt-dlp-auto';
    let isAutoGenerated = true;
    if (infoOutput.includes('Writing video subtitles to:')) {
        subtitleType = 'manual';
        source = 'yt-dlp-manual';
        isAutoGenerated = false;
    }

    // Parse metadata from --print output (one line containing |||)
    const printLine = (stdout || '').split(/\r?\n/).find((l) => l.includes('|||'));
    let title = null;
    let channelName = null;
    let durationSec = null;
    if (printLine) {
        const [t, u, d] = printLine.split('|||');
        title = t?.trim() || null;
        channelName = u?.trim() || null;
        const dRaw = d?.trim();
        durationSec = dRaw ? Number(dRaw) : null;
        if (Number.isNaN(durationSec)) durationSec = null;
    }

    return { stdout, stderr, title, channelName, durationSec, subtitleType, source, isAutoGenerated };
}

async function findVttFile(dir, outputPrefix, preferredLangs = []) {
    const files = await fs.readdir(dir);
    const vtts = files.filter((f) => f.startsWith(outputPrefix) && f.endsWith('.vtt'));
    if (!vtts.length) return null;
    if (preferredLangs.length) {
        for (const lang of preferredLangs) {
            const match = vtts.find((f) => f.includes(`.${lang}.`));
            if (match) return path.join(dir, match);
        }
    }
    return path.join(dir, vtts[0]);
}

async function loadVttAndParse(filePath, { removeBrackets }) {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseVtt(content, { removeBrackets });
}

async function cleanTempDir(dir) {
    try {
        const files = await fs.readdir(dir);
        await Promise.all(files.map((f) => fs.unlink(path.join(dir, f))));
        await fs.rmdir(dir);
    } catch (e) {
        log.warning(`Could not clean temp dir ${dir}: ${e?.message}`);
    }
}

async function getProxyUrl(mode) {
    if (mode === 'off') return null;
    try {
        if (mode === 'residential') {
            const cfg = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] });
            return cfg?.newUrl();
        }
        // default datacenter or auto
        const cfg = await Actor.createProxyConfiguration();
        return cfg?.newUrl();
    } catch {
        return null;
    }
}

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    videoUrl,
    preferredLanguage,
    languagePreference,
    outputMode = 'text_only',
    removeBrackets = true,
    joinWith = 'space',
    proxyMode = 'auto',
    timeoutMs: inputTimeoutMs,
    timeoutSecs,
    maxRetries = 2,
    saveVttToKV = false,
    enableWhisper = false,
    debug = false,
} = input;

const timeoutMs = inputTimeoutMs ?? (typeof timeoutSecs === 'number' ? timeoutSecs * 1000 : 180000);
const languagePrefs = normalizePreferredLanguage(preferredLanguage ?? languagePreference);
const whisperEnabled = Boolean(enableWhisper);

const videoId = extractVideoId(videoUrl || '');
if (!videoId) {
    await Actor.pushData({ status: 'INVALID_URL', videoUrl, reason: 'Invalid or unsupported YouTube URL' });
    await Actor.exit();
}

const canonicalUrl = canonicalWatchUrl(videoId);
const cacheStore = await Actor.openKeyValueStore();
const requestedLangKey = languagePrefs?.[0] || 'default';
const cacheKey = `yt:${videoId}:${requestedLangKey}`;
const requestedLanguage = languagePrefs?.[0] || null;
const cached = await cacheStore.getValue(cacheKey);
if (cached) {
    await Actor.pushData({ ...cached, cacheHit: true, cacheKey });
    await Actor.exit();
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-tx-'));
const outputPrefix = 'transcript';
const outputTemplate = path.join(tempDir, outputPrefix);

const attempts = [];
if (proxyMode === 'auto') attempts.push('datacenter', 'residential');
else if (proxyMode === 'off') attempts.push('off');
else attempts.push(proxyMode);
const proxyAttempted = [];

const hasProxyAuth = Boolean(process.env.APIFY_TOKEN || process.env.APIFY_PROXY_PASSWORD);
if ((proxyMode === 'datacenter' || proxyMode === 'residential') && !hasProxyAuth) {
    await Actor.pushData({
        status: 'ERROR',
        reason: 'Proxy mode requested but APIFY_TOKEN/APIFY_PROXY_PASSWORD not set',
        videoUrl: canonicalUrl,
        videoId,
        requestedLanguage,
        selectedLanguage: null,
        languageFallback: false,
        subtitleType: 'none',
        source: 'none',
        cacheHit: false,
        cacheKey,
        proxyAttempted: [],
    });
    await Actor.exit();
}

if (debug) {
    log.info(`proxyMode=${proxyMode}`);
    try {
        const { stdout } = await runYtDlp(['--version'], { proxyUrl: null, timeoutMs, debug, proxyInjected: false });
        log.info(`yt-dlp version: ${String(stdout || '').trim()}`);
    } catch {
        log.info('yt-dlp version: unknown');
    }
}

let lastError = null;
let blockedReason = null;
let title = null;
let channelName = null;
let usedLanguage = null;
let isAutoGenerated = null;

try {
    for (const mode of attempts) {
        const proxyUrl = await getProxyUrl(mode === 'datacenter' ? 'datacenter' : mode);
        const proxyInjected = Boolean(proxyUrl) && mode !== 'off';
        if (mode !== 'off') proxyAttempted.push(mode);

        for (let attempt = 0; attempt < Math.max(1, maxRetries); attempt++) {
            try {
                await Actor.sleep(Math.floor(500 + Math.random() * 1000));

                // Default to 'en' when no language preference given to avoid downloading all languages
                const subLangs = languagePrefs.length ? languagePrefs : ['en'];
                const dlResult = await downloadSubtitlesWithMeta({
                    url: canonicalUrl,
                    outputTemplate,
                    subLangs,
                    proxyUrl,
                    timeoutMs,
                    debug,
                    proxyInjected,
                });

                const vttPath = await findVttFile(tempDir, outputPrefix, subLangs);
                if (!vttPath) {
                    blockedReason = normalizeBlockedReason(dlResult.stderr || '');
                    if (blockedReason !== 'unknown') throw new Error(`BLOCKED:${blockedReason}`);
                    throw new Error('NO_TRANSCRIPT');
                }

                const warnings = [];
                if (whisperEnabled) warnings.push('Whisper fallback is disabled in this version.');

                const fname = path.basename(vttPath);
                const parts = fname.split('.');
                if (parts.length >= 3) usedLanguage = parts[parts.length - 2];
                if (languagePrefs.length && usedLanguage && !languagePrefs.includes(usedLanguage)) {
                    warnings.push('Preferred language not found; using default track.');
                }

                const segments = dedupeSegments(await loadVttAndParse(vttPath, { removeBrackets }));
                const transcriptText = buildTranscriptText(segments, joinWith);
                if (!transcriptText) throw new Error('EMPTY_TRANSCRIPT');

                title = dlResult.title;
                channelName = dlResult.channelName;
                const durationSec = dlResult.durationSec;
                const { subtitleType, source } = dlResult;
                isAutoGenerated = dlResult.isAutoGenerated;

                const languageFallback = warnings.length > 0;
                const output = {
                    status: 'SUCCESS',
                    videoUrl: canonicalUrl,
                    videoId,
                    transcriptText,
                    requestedLanguage,
                    selectedLanguage: usedLanguage || null,
                    languageFallback,
                    subtitleType,
                    source,
                    isAutoGenerated: !!isAutoGenerated,
                    warnings,
                    meta: {},
                    cacheHit: false,
                    cacheKey,
                    proxyAttempted,
                };

                if (title) output.title = title;
                if (channelName) output.channelName = channelName;
                if (durationSec != null) output.durationSec = durationSec;
                if (outputMode === 'text_and_segments') output.segments = segments;

                if (saveVttToKV && vttPath) {
                    const vttContent = await fs.readFile(vttPath, 'utf-8');
                    const vttKvKey = `vtt:${videoId}:${usedLanguage || 'default'}`;
                    await cacheStore.setValue(vttKvKey, vttContent, { contentType: 'text/vtt' });
                    output.vttKvKey = vttKvKey;
                    output.vttFilename = path.basename(vttPath);
                }

                await cacheStore.setValue(cacheKey, output);
                if (usedLanguage && usedLanguage !== requestedLangKey) {
                    await cacheStore.setValue(`yt:${videoId}:${usedLanguage}`, output);
                }

                await Actor.pushData(output);
                await Actor.exit();
            } catch (err) {
                const msg = err?.message || String(err);
                if (msg.startsWith('BLOCKED:')) {
                    blockedReason = msg.split(':')[1];
                    lastError = msg;
                    break; // switch proxy mode
                }
                lastError = msg;
                if (attempt === Math.max(1, maxRetries) - 1) break;
            }
        }
    }
} finally {
    await cleanTempDir(tempDir);
}

const errorOutput = {
    status: blockedReason ? 'BLOCKED' : 'NO_TRANSCRIPT',
    reason: blockedReason ? 'Blocked by YouTube' : 'No transcripts available',
    subtitleType: 'none',
    source: 'none',
    requestedLanguage,
    selectedLanguage: null,
    languageFallback: false,
    videoUrl: canonicalUrl,
    videoId,
    cacheHit: false,
    cacheKey,
    proxyAttempted,
    lastError,
};
if (lastError === 'EMPTY_TRANSCRIPT') errorOutput.reason = 'Transcript file was empty after parsing';
if (blockedReason) errorOutput.blocked_reason = blockedReason;
if (title) errorOutput.title = title;
if (channelName) errorOutput.channelName = channelName;

await Actor.pushData(errorOutput);
await Actor.exit();
