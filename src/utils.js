const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com']);

export function extractVideoId(url) {
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

export function canonicalWatchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

export function normalizePreferredLanguage(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.filter(Boolean);
    if (typeof input === 'string') return [input];
    return [];
}

export function decodeHtmlEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        // Use fromCodePoint for emoji/high Unicode; guard against out-of-range values
        .replace(/&#(\d+);/g, (_, n) => { const cp = parseInt(n, 10); return cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''; })
        .replace(/\u2028/g, ' ')
        .replace(/\u2029/g, ' ');
}

export function normalizeText(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;!?])/g, '$1')
        .replace(/\u00a0/g, ' ')
        .trim();
}

export function cleanSegmentText(text, { removeBrackets = true } = {}) {
    let t = String(text || '').trim();
    if (removeBrackets) t = t.replace(/\[[^\]]+\]/g, '').trim();
    // Remove ALL-CAPS speaker labels like "SPEAKER:" or "JOHN DOE:"
    t = t.replace(/^([A-Z][A-Z0-9 ]{2,}):\s+/, '');
    return normalizeText(t);
}

export function parseTimestamp(ts) {
    const m = ts.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const [, h, min, sec] = m;
    return Number(h) * 3600 + Number(min) * 60 + Number(sec);
}

export function parseVtt(vttContent, { removeBrackets = true } = {}) {
    const lines = vttContent.split(/\r?\n/);
    const segments = [];
    let current = [];
    let startSec = null;
    let endSec = null;
    // A blank line between cues means the next non-timing line is a cue identifier
    // (optional label like "1" or "intro") that must be skipped, not treated as text.
    let skipNextTextLine = true;

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
        if (!l || l.startsWith('WEBVTT') || l.startsWith('Kind:') || l.startsWith('Language:')) {
            if (!l) skipNextTextLine = true; // blank line separates cues
            continue;
        }
        if (l.includes('-->')) {
            flush();
            const [start, end] = l.split('-->').map((s) => s.trim());
            startSec = parseTimestamp(start);
            endSec = parseTimestamp(end);
            skipNextTextLine = false; // lines after timing are real cue text
            continue;
        }
        if (skipNextTextLine) {
            // This line is a cue identifier (e.g. "1", "2", "intro") — discard it
            skipNextTextLine = false;
            continue;
        }
        current.push(l);
    }
    flush();
    return segments;
}

export function dedupeSegments(segments) {
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

export function buildTranscriptText(segments, joinWith = 'space') {
    const sep = joinWith === 'newline' ? '\n' : ' ';
    return segments.map((s) => s.text).join(sep).replace(/\s+\n/g, '\n').trim();
}

export function normalizeBlockedReason(stderr = '') {
    const s = stderr.toLowerCase();
    if (s.includes('429') || s.includes('too many requests')) return '429';
    if (s.includes('captcha')) return 'captcha';
    // Check specific phrase before generic "sign in" to avoid false positives
    if (s.includes('sign in to confirm')) return 'signin_required';
    if (s.includes('consent') && s.includes('loop')) return 'consent_loop';
    // Generic sign-in check last — broad but less likely to false-positive after above
    if (s.includes('sign in')) return 'signin_required';
    return 'unknown';
}

export function sanitizeProxyArg(arg) {
    return arg.replace(/(https?:\/\/)([^:@]+):([^@]+)@/i, '$1***:***@');
}

export function sanitizeCommand(args) {
    const out = [...args];
    const proxyIdx = out.findIndex((a) => a === '--proxy');
    if (proxyIdx >= 0 && out[proxyIdx + 1]) {
        out[proxyIdx + 1] = sanitizeProxyArg(out[proxyIdx + 1]);
    }
    return out;
}

export function extractAvailableLanguages(listSubsOutput) {
    const lines = listSubsOutput.split(/\r?\n/);
    const langs = new Set();
    for (const line of lines) {
        const m = line.match(/^([a-zA-Z-]{2,})\s{2,}/);
        if (m) langs.add(m[1]);
    }
    return [...langs];
}

/**
 * Parses the tab-delimited stdout from:
 *   yt-dlp --print '%(title)s\t%(channel)s\t%(duration)s\t%(upload_date)s'
 */
export function parseMetadataLine(stdout) {
    const [title, channel, duration, uploadDate] = (stdout || '').trim().split('\t');
    const clean = (v) => (v && v !== 'NA' && v !== 'none' && v !== 'None') ? v.trim() : null;
    const rawDate = clean(uploadDate);
    // Convert YYYYMMDD → YYYY-MM-DD for consistency
    const formattedDate = rawDate?.match(/^\d{8}$/)
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : rawDate;
    return {
        title: clean(title),
        channelName: clean(channel),
        durationSec: duration && !Number.isNaN(Number(duration)) ? Number(duration) : null,
        uploadDate: formattedDate ?? null,
    };
}
