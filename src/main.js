import { Actor, log } from 'apify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────
const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com']);
const VIDEO_ID_LENGTH = 11;
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES_LIMIT = 10;
const YTDLP_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const METADATA_TIMEOUT_MS = 30_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

// ─── URL Helpers ──────────────────────────────────────────────────────────────
function extractVideoId(url) {
    try {
        const u = new URL(url);
        if (!YT_HOSTS.has(u.hostname)) return null;
        if (u.hostname === 'youtu.be') return u.pathname.slice(1, VIDEO_ID_LENGTH + 1) || null;
        if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2]?.slice(0, VIDEO_ID_LENGTH) || null;
        if (u.pathname === '/watch') return u.searchParams.get('v')?.slice(0, VIDEO_ID_LENGTH) || null;
        return null;
    } catch {
        return null;
    }
}

function canonicalWatchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

// ─── Language Helpers ─────────────────────────────────────────────────────────
function normalizePreferredLanguage(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
    if (typeof input === 'string' && input.trim()) return [input.trim()];
    return [];
}

// ─── Text Processing ──────────────────────────────────────────────────────────
const HTML_ENTITY_MAP = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|nbsp|#(\d+));/g;

function decodeHtmlEntities(text) {
    return text
        .replace(HTML_ENTITY_RE, (match, num) =>
            num !== undefined ? String.fromCharCode(parseInt(num, 10)) : (HTML_ENTITY_MAP[match] ?? match),
        )
        .replace(/[\u2028\u2029]/g, ' ');
}

function normalizeText(text) {
    return text
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;!?])/g, '$1')
        .trim();
}

// Whitelist of known non-speech bracketed markers only — preserves [2023], [USA], etc.
const BRACKET_RE = /\[(?:Music|Applause|Laughter|Silence|Inaudible|Crosstalk|Background(?:\s+\w+)?|Translated\s+by[^\]]*)\]/gi;
// Requires 2+ consecutive ALL-CAPS words so single words like "USA:" are not stripped
const SPEAKER_LABEL_RE = /^(?:[A-Z]{2,}(?:\s+[A-Z]{2,})*):\s+/;

function cleanSegmentText(text, { removeBrackets = true }) {
    let t = String(text || '').trim();
    if (removeBrackets) t = t.replace(BRACKET_RE, '').trim();
    t = t.replace(SPEAKER_LABEL_RE, '');
    return normalizeText(t);
}

// ─── Timestamp / VTT Parsing ──────────────────────────────────────────────────
// Regex enforces MM and SS are 00-59, rejecting values like "99:99:99"
function parseTimestamp(ts) {
    const m = ts.match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
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
        if (!l) continue;
        // Skip VTT header lines and numeric-only SRT-style cue IDs
        if (
            l.startsWith('WEBVTT') ||
            l.startsWith('Kind:') ||
            l.startsWith('Language:') ||
            l.startsWith('NOTE') ||
            /^\d+$/.test(l)
        ) continue;
        if (l.includes('-->')) {
            flush();
            const arrowIdx = l.indexOf('-->');
            const startStr = l.slice(0, arrowIdx).trim();
            // Strip optional VTT cue settings (e.g. "position:50% align:center") after end timestamp
            const endStr = l.slice(arrowIdx + 3).trim().split(/\s/)[0];
            startSec = parseTimestamp(startStr);
            endSec = parseTimestamp(endStr);
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
        if (!s.text || seen.has(s.text)) continue;
        seen.add(s.text);
        out.push(s);
    }
    return out;
}

function buildTranscriptText(segments, joinWith = 'space') {
    const sep = joinWith === 'newline' ? '\n' : ' ';
    return segments.map((s) => s.text).join(sep).replace(/\s+\n/g, '\n').trim();
}

// ─── Error Classification ─────────────────────────────────────────────────────
const BLOCKED_PATTERNS = [
    [/429|too many requests/i, 'BLOCKED:429'],
    [/captcha/i, 'BLOCKED:captcha'],
    [/sign in to confirm|sign in/i, 'BLOCKED:signin_required'],
    [/consent.*loop|loop.*consent/i, 'BLOCKED:consent_loop'],
];
const UNAVAILABLE_PATTERNS = [
    [/video unavailable|this video is not available/i, 'UNAVAILABLE'],
    [/private video|this video is private/i, 'PRIVATE'],
    [/video has been removed|no longer available/i, 'REMOVED'],
    [/age.?restricted/i, 'AGE_RESTRICTED'],
];
const UNAVAILABLE_CODES = new Set(['UNAVAILABLE', 'PRIVATE', 'REMOVED', 'AGE_RESTRICTED']);

function classifyYtDlpError(text) {
    for (const [re, code] of BLOCKED_PATTERNS) {
        if (re.test(text)) return code;
    }
    for (const [re, code] of UNAVAILABLE_PATTERNS) {
        if (re.test(text)) return code;
    }
    return null;
}

// ─── Credential Sanitization ──────────────────────────────────────────────────
function sanitizeProxyArg(arg) {
    return typeof arg === 'string' ? arg.replace(/(https?:\/\/)([^:@]+):([^@]+)@/i, '$1***:***@') : arg;
}

function sanitizeCommand(args) {
    const out = [...args];
    const idx = out.findIndex((a) => a === '--proxy');
    if (idx >= 0 && out[idx + 1]) out[idx + 1] = sanitizeProxyArg(out[idx + 1]);
    return out;
}

// ─── yt-dlp Wrapper ───────────────────────────────────────────────────────────
async function runYtDlp(args, { proxyUrl = null, timeoutMs, debug = false, proxyInjected = false }) {
    const finalArgs = [...args];
    if (proxyUrl) finalArgs.push('--proxy', proxyUrl);
    if (debug) {
        log.debug(`yt-dlp ${sanitizeCommand(finalArgs).join(' ')} [proxyInjected=${proxyInjected}]`);
    }
    try {
        const { stdout, stderr } = await execFileAsync('yt-dlp', finalArgs, {
            timeout: timeoutMs,
            maxBuffer: YTDLP_MAX_BUFFER,
        });
        return { stdout: stdout || '', stderr: stderr || '' };
    } catch (err) {
        // Classify error before propagating so raw proxy credentials never appear in thrown messages
        const stderr = err?.stderr || err?.message || '';
        const classified = classifyYtDlpError(stderr);
        if (classified) throw new Error(classified);
        if (debug && stderr) {
            log.debug(`yt-dlp stderr:\n${stderr.split(/\r?\n/).slice(0, 15).join('\n')}`);
        }
        throw err;
    }
}

// Single yt-dlp call for all metadata fields — avoids 3 sequential subprocesses
async function fetchMetadata(canonicalUrl, opts) {
    try {
        const { stdout } = await runYtDlp(
            ['--no-playlist', '--print', '%(title)s', '--print', '%(uploader)s', '--print', '%(duration)s', canonicalUrl],
            { ...opts, timeoutMs: Math.min(opts.timeoutMs, METADATA_TIMEOUT_MS) },
        );
        const lines = (stdout || '').trim().split('\n');
        const durationSec = lines[2] && !Number.isNaN(Number(lines[2])) ? Number(lines[2]) : null;
        return { title: lines[0] || null, channelName: lines[1] || null, durationSec };
    } catch (err) {
        log.warning(`Metadata fetch failed: ${err?.message ?? err}`);
        return { title: null, channelName: null, durationSec: null };
    }
}

async function listSubtitles(url, opts) {
    return runYtDlp(['--list-subs', '--no-playlist', url], opts);
}

function extractAvailableLanguages(stdout) {
    const langs = new Set();
    for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^([a-zA-Z][\w-]{1,})\s{2,}/);
        if (m) langs.add(m[1]);
    }
    return [...langs];
}

async function downloadSubtitles({ url, outputTemplate, preferredLanguage, autoGenerated, ...opts }) {
    const args = [
        autoGenerated ? '--write-auto-sub' : '--write-sub',
        '--skip-download', '--no-playlist', '--sub-format', 'vtt',
        '--output', outputTemplate,
    ];
    if (preferredLanguage?.length) args.push('--sub-langs', preferredLanguage.join(','));
    args.push(url);
    return runYtDlp(args, opts);
}

async function findVttFile(dir, outputPrefix) {
    const files = await fs.readdir(dir);
    const found = files.find((f) => f.startsWith(outputPrefix) && f.endsWith('.vtt'));
    return found ? path.join(dir, found) : null;
}

// ─── Proxy Helper ─────────────────────────────────────────────────────────────
async function getProxyUrl(mode) {
    if (mode === 'off') return null;
    try {
        const cfg = await Actor.createProxyConfiguration(
            mode === 'residential' ? { groups: ['RESIDENTIAL'] } : {},
        );
        return cfg?.newUrl() ?? null;
    } catch (err) {
        log.warning(`Proxy setup failed (mode="${mode}"): ${err?.message ?? err}`);
        return null;
    }
}

// ─── Retry Delay (exponential backoff + jitter) ───────────────────────────────
function getRetryDelay(attempt) {
    return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS) + Math.floor(Math.random() * 500);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    videoUrl,
    preferredLanguage,
    languagePreference, // legacy alias — silently supported, not exposed in schema
    outputMode = 'text_only',
    removeBrackets = true,
    joinWith = 'space',
    proxyMode = 'auto',
    timeoutMs: rawTimeoutMs,
    timeoutSecs,
    maxRetries: rawMaxRetries = 2,
    saveVttToKV = false,
    debug = false,
} = input;

if (debug) log.setLevel(log.LEVELS.DEBUG);

// Clamp inputs to safe ranges
const timeoutMs = Math.min(
    Math.max(rawTimeoutMs ?? (typeof timeoutSecs === 'number' ? timeoutSecs * 1000 : DEFAULT_TIMEOUT_MS), MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
);
const maxRetries = Math.min(Math.max(Number.isInteger(rawMaxRetries) ? rawMaxRetries : 2, 0), MAX_RETRIES_LIMIT);
const languagePrefs = normalizePreferredLanguage(preferredLanguage ?? languagePreference);

if (debug) {
    log.debug(`Input: videoUrl=${videoUrl}, timeoutMs=${timeoutMs}, maxRetries=${maxRetries}, proxyMode=${proxyMode}`);
}

// Validate URL
const videoId = extractVideoId(videoUrl || '');
if (!videoId) {
    await Actor.pushData({ status: 'INVALID_URL', videoUrl, reason: 'Invalid or unsupported YouTube URL' });
    await Actor.exit();
}

const canonicalUrl = canonicalWatchUrl(videoId);
const requestedLangKey = languagePrefs[0] || 'default';
const requestedLanguage = languagePrefs[0] || null;
const cacheKey = `yt:${videoId}:${requestedLangKey}`;

// Cache check
const cacheStore = await Actor.openKeyValueStore();
const cached = await cacheStore.getValue(cacheKey);
if (cached) {
    log.info(`Cache hit for ${videoId} (${requestedLangKey})`);
    await Actor.pushData({ ...cached, cacheHit: true, cacheKey });
    await Actor.exit();
}

// Proxy auth guard
const hasProxyAuth = Boolean(process.env.APIFY_TOKEN || process.env.APIFY_PROXY_PASSWORD);
if (proxyMode !== 'off' && !hasProxyAuth) {
    log.warning('Proxy requested but no APIFY credentials found — running without proxy.');
}

// Build attempt sequence; collapse to ['off'] when no credentials are available
const proxyModes = proxyMode === 'auto'
    ? (hasProxyAuth ? ['datacenter', 'residential'] : ['off'])
    : (proxyMode !== 'off' && hasProxyAuth ? [proxyMode] : ['off']);

if (debug) {
    try {
        const { stdout } = await runYtDlp(['--version'], { proxyUrl: null, timeoutMs: 10_000, debug, proxyInjected: false });
        log.debug(`yt-dlp version: ${stdout.trim()}`);
    } catch {
        log.debug('yt-dlp version: unknown');
    }
}

// Temp dir for downloaded VTT files
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-tx-'));
const outputTemplate = path.join(tempDir, 'transcript');

let lastError = null;
let blockedReason = null;
let unavailableReason = null;
const proxyAttempted = [];
let successOutput = null;

outer: for (const mode of proxyModes) {
    const proxyUrl = mode !== 'off' ? await getProxyUrl(mode) : null;
    const proxyInjected = Boolean(proxyUrl);
    if (mode !== 'off') proxyAttempted.push(mode);
    const opts = { proxyUrl, timeoutMs, debug, proxyInjected };

    // attempt 0 = first try; attempts 1..maxRetries = retries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = getRetryDelay(attempt - 1);
            log.info(`Retry ${attempt}/${maxRetries} (mode=${mode}), waiting ${delay}ms…`);
            await Actor.sleep(delay);
        }

        try {
            // List available subtitle tracks
            const listRes = await listSubtitles(canonicalUrl, opts);
            const availableLangs = extractAvailableLanguages(listRes.stdout || '');

            if (!availableLangs.length) {
                const errClass = classifyYtDlpError(listRes.stderr || '');
                if (errClass) throw new Error(errClass);
            }

            const langToUse = languagePrefs.length ? languagePrefs : null;
            const langWarning = langToUse?.length && !availableLangs.some((l) => langToUse.includes(l))
                ? 'Preferred language not found; using default track.'
                : null;

            // Try manual subs first, fall back to auto-generated
            let subtitleType = 'manual';
            let source = 'yt-dlp-manual';
            let isAutoGenerated = false;

            await downloadSubtitles({ url: canonicalUrl, outputTemplate, preferredLanguage: langToUse, autoGenerated: false, ...opts });
            let vttPath = await findVttFile(tempDir, 'transcript');

            if (!vttPath) {
                subtitleType = 'auto';
                source = 'yt-dlp-auto';
                isAutoGenerated = true;
                const dlAuto = await downloadSubtitles({ url: canonicalUrl, outputTemplate, preferredLanguage: langToUse, autoGenerated: true, ...opts });
                vttPath = await findVttFile(tempDir, 'transcript');
                if (!vttPath) {
                    const errClass = classifyYtDlpError(dlAuto.stderr || '');
                    if (errClass) throw new Error(errClass);
                    throw new Error('NO_TRANSCRIPT');
                }
            }

            // Parse transcript
            const vttContent = await fs.readFile(vttPath, 'utf-8');
            const segments = dedupeSegments(parseVtt(vttContent, { removeBrackets }));
            const transcriptText = buildTranscriptText(segments, joinWith);

            // Fetch all metadata in one yt-dlp call
            const meta = await fetchMetadata(canonicalUrl, opts);

            // Determine actual language from VTT filename (transcript.<lang>.vtt)
            const fname = path.basename(vttPath);
            const fnParts = fname.split('.');
            const usedLanguage = fnParts.length >= 3 ? fnParts[fnParts.length - 2] : null;

            const warnings = langWarning ? [langWarning] : [];
            successOutput = {
                status: 'SUCCESS',
                videoUrl: canonicalUrl,
                videoId,
                transcriptText,
                requestedLanguage,
                selectedLanguage: usedLanguage,
                languageFallback: warnings.length > 0,
                subtitleType,
                source,
                isAutoGenerated,
                warnings,
                cacheHit: false,
                cacheKey,
                proxyAttempted,
                ...(meta.title && { title: meta.title }),
                ...(meta.channelName && { channelName: meta.channelName }),
                ...(meta.durationSec != null && { durationSec: meta.durationSec }),
                ...(outputMode === 'text_and_segments' && { segments }),
            };

            if (saveVttToKV) {
                const vttKvKey = `vtt:${videoId}:${usedLanguage || 'default'}`;
                await cacheStore.setValue(vttKvKey, vttContent, { contentType: 'text/vtt' });
                successOutput.vttKvKey = vttKvKey;
                successOutput.vttFilename = fname;
            }

            // Cache result under both the requested key and actual language key
            await cacheStore.setValue(cacheKey, successOutput);
            if (usedLanguage && usedLanguage !== requestedLangKey) {
                await cacheStore.setValue(`yt:${videoId}:${usedLanguage}`, successOutput);
            }

            break outer; // done — exit both loops
        } catch (err) {
            const msg = err?.message || String(err);
            lastError = msg;

            if (msg.startsWith('BLOCKED:')) {
                blockedReason = msg.slice(8);
                log.warning(`Blocked (${blockedReason}) on mode=${mode}, attempt=${attempt}`);
                break; // try next proxy mode
            }
            if (UNAVAILABLE_CODES.has(msg)) {
                unavailableReason = msg;
                log.warning(`Video not accessible: ${msg}`);
                break outer; // video itself is the problem — no point retrying
            }
            log.warning(`Attempt ${attempt}/${maxRetries} failed (mode=${mode}): ${msg}`);
        }
    }
}

// Clean up temp dir before exit
await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

if (successOutput) {
    await Actor.pushData(successOutput);
} else {
    const status = unavailableReason || (blockedReason ? 'BLOCKED' : 'NO_TRANSCRIPT');
    const reason = unavailableReason
        ? `Video is ${unavailableReason.toLowerCase().replace('_', ' ')}`
        : blockedReason
            ? 'Blocked by YouTube'
            : 'No transcripts available for this video';

    await Actor.pushData({
        status,
        reason,
        lastError,
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
        ...(blockedReason && { blocked_reason: blockedReason }),
    });
}

await Actor.exit();
