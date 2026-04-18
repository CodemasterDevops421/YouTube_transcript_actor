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

// Parse YYYYMMDD from yt-dlp into ISO date string YYYY-MM-DD
function parseUploadDate(raw) {
    if (!raw || raw === 'NA' || raw === 'None' || raw.length !== 8) return null;
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

// Parse an integer field that yt-dlp may return as 'NA' or 'None'
function parseIntField(raw) {
    if (!raw || raw === 'NA' || raw === 'None') return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
}

// Parse comma-separated tags string into array
function parseTags(raw) {
    if (!raw || raw === 'NA' || raw === 'None') return [];
    return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

// Compute word count and character count from transcript text
function transcriptStats(text) {
    if (!text) return { wordCount: 0, charCount: 0 };
    return {
        wordCount: text.trim().split(/\s+/).filter(Boolean).length,
        charCount: text.length,
    };
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

async function listSubtitles(url, { proxyUrl, timeoutMs, debug, proxyInjected }) {
    const { stdout, stderr } = await runYtDlp(['--list-subs', url], { proxyUrl, timeoutMs, debug, proxyInjected });
    return { stdout, stderr };
}

function extractAvailableLanguages(listSubsOutput) {
    const lines = listSubsOutput.split(/\r?\n/);
    const langs = new Set();
    for (const line of lines) {
        // Typical format: "en  English"
        const m = line.match(/^([a-zA-Z-]{2,})\s{2,}/);
        if (m) langs.add(m[1]);
    }
    return [...langs];
}

async function downloadSubtitles({ url, outputTemplate, preferredLanguage, autoGenerated, proxyUrl, timeoutMs, debug, proxyInjected }) {
    const args = [
        autoGenerated ? '--write-auto-sub' : '--write-sub',
        '--skip-download',
        '--sub-format', 'vtt',
        '--output', outputTemplate,
    ];
    if (preferredLanguage?.length) {
        args.push('--sub-langs', preferredLanguage.join(','));
    }
    args.push(url);
    const { stdout, stderr } = await runYtDlp(args, { proxyUrl, timeoutMs, debug, proxyInjected });
    return { stdout, stderr };
}

async function findVttFile(dir, outputPrefix) {
    const files = await fs.readdir(dir);
    const vtt = files.find((f) => f.startsWith(outputPrefix) && f.endsWith('.vtt')) || null;
    return vtt ? path.join(dir, vtt) : null;
}

async function loadVttAndParse(filePath, { removeBrackets }) {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseVtt(content, { removeBrackets });
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
    videoUrls,
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
    debug = false,
} = input;

const timeoutMs = inputTimeoutMs ?? (typeof timeoutSecs === 'number' ? timeoutSecs * 1000 : 180000);
const languagePrefs = normalizePreferredLanguage(preferredLanguage ?? languagePreference);
const requestedLanguage = languagePrefs?.[0] || null;
const requestedLangKey = languagePrefs?.[0] || 'default';

// Normalize to an array of URLs — accept either videoUrls[] or single videoUrl
const rawUrls = Array.isArray(videoUrls) && videoUrls.length ? videoUrls : videoUrl ? [videoUrl] : [];
if (!rawUrls.length) {
    await Actor.pushData({ status: 'INVALID_URL', reason: 'No videoUrl or videoUrls provided' });
    await Actor.exit();
}

// Validate each URL and push errors for invalid ones immediately
const parsedUrls = rawUrls.map((u) => ({ raw: u, videoId: extractVideoId(u || '') }));
for (const { raw } of parsedUrls.filter((u) => !u.videoId)) {
    await Actor.pushData({ status: 'INVALID_URL', videoUrl: raw, reason: 'Invalid or unsupported YouTube URL' });
}
const validUrls = parsedUrls.filter((u) => u.videoId);
if (!validUrls.length) await Actor.exit();

const cacheStore = await Actor.openKeyValueStore();

// Proxy auth guard — checked once up front, applies to all videos
const hasProxyAuth = Boolean(process.env.APIFY_TOKEN || process.env.APIFY_PROXY_PASSWORD);
if ((proxyMode === 'datacenter' || proxyMode === 'residential') && !hasProxyAuth) {
    for (const { videoId } of validUrls) {
        const canonicalUrl = canonicalWatchUrl(videoId);
        const cacheKey = `yt:${videoId}:${requestedLangKey}`;
        await Actor.pushData({
            status: 'ERROR',
            reason: 'Proxy mode requested but APIFY_TOKEN/APIFY_PROXY_PASSWORD not set',
            videoUrl: canonicalUrl,
            videoId,
            requestedLanguage,
            selectedLanguage: null,
            languageFallback: false,
            isAutoGenerated: false,
            warnings: [],
            subtitleType: 'none',
            source: 'none',
            cacheHit: false,
            cacheKey,
            proxyAttempted: [],
        });
    }
    await Actor.exit();
}

// Proxy mode sequence to attempt
const proxyAttemptModes = [];
if (proxyMode === 'auto') proxyAttemptModes.push('datacenter', 'residential');
else if (proxyMode === 'off') proxyAttemptModes.push('off');
else proxyAttemptModes.push(proxyMode);

if (debug) {
    log.info(`proxyMode=${proxyMode}, videos=${validUrls.length}`);
    try {
        const { stdout } = await runYtDlp(['--version'], { proxyUrl: null, timeoutMs, debug, proxyInjected: false });
        log.info(`yt-dlp version: ${String(stdout || '').trim()}`);
    } catch {
        log.info('yt-dlp version: unknown');
    }
}

// Process each video
for (let i = 0; i < validUrls.length; i++) {
    const { videoId } = validUrls[i];
    const canonicalUrl = canonicalWatchUrl(videoId);
    const cacheKey = `yt:${videoId}:${requestedLangKey}`;

    await Actor.setStatusMessage(`Processing ${i + 1}/${validUrls.length}: ${videoId}`);

    // Return cached result immediately
    const cached = await cacheStore.getValue(cacheKey);
    if (cached) {
        await Actor.pushData({ ...cached, cacheHit: true, cacheKey });
        continue;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-tx-'));
    const outputPrefix = 'transcript';
    const outputTemplate = path.join(tempDir, outputPrefix);

    await (async () => {
        try {
            let lastError = null;
            let blockedReason = null;
            let title = null;
            let channelName = null;
            let usedLanguage = null;
            let isAutoGenerated = null;
            const proxyAttempted = [];

            for (const mode of proxyAttemptModes) {
                const proxyUrl = await getProxyUrl(mode === 'datacenter' ? 'datacenter' : mode);
                const proxyInjected = Boolean(proxyUrl) && mode !== 'off';
                if (mode !== 'off') proxyAttempted.push(mode);

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    // Clear any VTT files left by a previous attempt
                    try {
                        const staleVtts = (await fs.readdir(tempDir)).filter((f) => f.endsWith('.vtt'));
                        await Promise.all(staleVtts.map((f) => fs.unlink(path.join(tempDir, f))));
                    } catch {}
                    const warnings = [];

                    try {
                        await Actor.sleep(Math.floor(500 + Math.random() * 1000));

                        const listRes = await listSubtitles(canonicalUrl, { proxyUrl, timeoutMs, debug, proxyInjected });
                        const availableLanguages = extractAvailableLanguages(listRes.stdout || '');
                        if (!availableLanguages.length) {
                            blockedReason = normalizeBlockedReason(listRes.stderr || '');
                            if (blockedReason !== 'unknown') throw new Error(`BLOCKED:${blockedReason}`);
                        }

                        const langToUse = languagePrefs.length ? languagePrefs : null;
                        if (langToUse?.length && !availableLanguages.some((l) => langToUse.includes(l))) {
                            warnings.push('Preferred language not found; using default track.');
                        }

                        // Try manual subs first, then auto-generated
                        let subtitleType = 'manual';
                        let source = 'yt-dlp-manual';
                        let dl = await downloadSubtitles({ url: canonicalUrl, outputTemplate, preferredLanguage: langToUse, autoGenerated: false, proxyUrl, timeoutMs, debug, proxyInjected });
                        let vttPath = await findVttFile(tempDir, outputPrefix);
                        if (!vttPath) {
                            subtitleType = 'auto';
                            source = 'yt-dlp-auto';
                            dl = await downloadSubtitles({ url: canonicalUrl, outputTemplate, preferredLanguage: langToUse, autoGenerated: true, proxyUrl, timeoutMs, debug, proxyInjected });
                            vttPath = await findVttFile(tempDir, outputPrefix);
                            isAutoGenerated = true;
                        }

                        if (!vttPath) {
                            blockedReason = normalizeBlockedReason(dl.stderr || '');
                            if (blockedReason !== 'unknown') throw new Error(`BLOCKED:${blockedReason}`);
                            throw new Error('NO_TRANSCRIPT');
                        }

                        // Parse VTT and derive stats
                        const segments = dedupeSegments(await loadVttAndParse(vttPath, { removeBrackets }));
                        const transcriptText = buildTranscriptText(segments, joinWith);
                        const { wordCount, charCount } = transcriptStats(transcriptText);

                        // Fetch all enrichment metadata in a single yt-dlp call
                        let durationSec = null;
                        let uploadDate = null;
                        let viewCount = null;
                        let likeCount = null;
                        let channelId = null;
                        let thumbnailUrl = null;
                        let tags = [];
                        try {
                            const { stdout } = await runYtDlp(
                                [
                                    '--print',
                                    '%(title)s\t%(uploader)s\t%(duration)s\t%(upload_date)s\t%(view_count)s\t%(like_count)s\t%(channel_id)s\t%(thumbnail)s\t%(tags)s',
                                    canonicalUrl,
                                ],
                                { proxyUrl, timeoutMs, debug, proxyInjected }
                            );
                            const [
                                rTitle, rUploader, rDuration, rUploadDate,
                                rViewCount, rLikeCount, rChannelId, rThumbnail, rTags,
                            ] = (stdout || '').trim().split('\t');
                            title = rTitle || null;
                            channelName = rUploader || null;
                            durationSec = rDuration ? Number(rDuration) : null;
                            if (Number.isNaN(durationSec)) durationSec = null;
                            uploadDate = parseUploadDate(rUploadDate);
                            viewCount = parseIntField(rViewCount);
                            likeCount = parseIntField(rLikeCount);
                            channelId = rChannelId && rChannelId !== 'NA' ? rChannelId : null;
                            thumbnailUrl = rThumbnail && rThumbnail !== 'NA' ? rThumbnail : null;
                            tags = parseTags(rTags);
                        } catch {}

                        // Determine the language code from the VTT filename: transcript.<lang>.vtt
                        const fname = path.basename(vttPath);
                        const parts = fname.split('.');
                        if (parts.length >= 3) usedLanguage = parts[parts.length - 2];

                        const languageFallback = Boolean(
                            requestedLanguage &&
                            usedLanguage &&
                            usedLanguage !== requestedLanguage
                        );

                        const output = {
                            status: 'SUCCESS',
                            videoUrl: canonicalUrl,
                            videoId,
                            title: title || null,
                            channelName: channelName || null,
                            channelId: channelId || null,
                            uploadDate: uploadDate || null,
                            durationSec: durationSec ?? null,
                            viewCount: viewCount ?? null,
                            likeCount: likeCount ?? null,
                            thumbnailUrl: thumbnailUrl || null,
                            tags,
                            transcriptText,
                            wordCount,
                            charCount,
                            requestedLanguage,
                            selectedLanguage: usedLanguage || null,
                            availableLanguages,
                            languageFallback,
                            subtitleType,
                            source,
                            isAutoGenerated: !!isAutoGenerated,
                            warnings,
                            cacheHit: false,
                            cacheKey,
                            proxyAttempted,
                        };

                        if (outputMode === 'text_and_segments') output.segments = segments;

                        if (saveVttToKV && vttPath) {
                            const vttContent = await fs.readFile(vttPath, 'utf-8');
                            const vttKvKey = `vtt:${videoId}:${usedLanguage || 'default'}`;
                            const vttFilename = path.basename(vttPath);
                            await cacheStore.setValue(vttKvKey, vttContent, { contentType: 'text/vtt' });
                            output.vttKvKey = vttKvKey;
                            output.vttFilename = vttFilename;
                        }

                        await cacheStore.setValue(cacheKey, output);
                        if (usedLanguage && usedLanguage !== requestedLangKey) {
                            await cacheStore.setValue(`yt:${videoId}:${usedLanguage}`, output);
                        }

                        await Actor.pushData(output);
                        return;
                    } catch (err) {
                        const msg = err?.message || String(err);
                        if (msg.startsWith('BLOCKED:')) {
                            blockedReason = msg.split(':')[1];
                            lastError = msg;
                            break; // switch proxy mode
                        }
                        lastError = msg;
                        if (attempt === maxRetries) break;
                    }
                }
            }

            const errorOutput = {
                status: blockedReason ? 'BLOCKED' : 'NO_TRANSCRIPT',
                reason: blockedReason ? 'Blocked by YouTube' : 'No transcripts available',
                subtitleType: 'none',
                source: 'none',
                requestedLanguage,
                selectedLanguage: null,
                languageFallback: false,
                isAutoGenerated: false,
                warnings: [],
                videoUrl: canonicalUrl,
                videoId,
                cacheHit: false,
                cacheKey,
                proxyAttempted,
            };
            if (blockedReason) errorOutput.blocked_reason = blockedReason;
            if (title) errorOutput.title = title;
            if (channelName) errorOutput.channelName = channelName;

            await Actor.pushData(errorOutput);
        } finally {
            try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
        }
    })();
}

await Actor.setStatusMessage('Done');
await Actor.exit();
