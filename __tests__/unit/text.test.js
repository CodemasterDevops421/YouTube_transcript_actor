import {
    decodeHtmlEntities,
    normalizeText,
    cleanSegmentText,
    normalizePreferredLanguage,
    normalizeBlockedReason,
    parseMetadataLine,
} from '../../src/utils.js';

describe('decodeHtmlEntities', () => {
    test('decodes &amp;', () => {
        expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    });

    test('decodes &lt; and &gt;', () => {
        expect(decodeHtmlEntities('&lt;div&gt;')).toBe('<div>');
    });

    test('decodes &quot;', () => {
        expect(decodeHtmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
    });

    test("decodes &#39;", () => {
        expect(decodeHtmlEntities("it&#39;s fine")).toBe("it's fine");
    });

    test('decodes numeric character entity &#65; to A', () => {
        expect(decodeHtmlEntities('&#65;')).toBe('A');
    });

    test('decodes numeric entity &#9829; to heart symbol', () => {
        expect(decodeHtmlEntities('&#9829;')).toBe('♥');
    });

    test('correctly decodes emoji using high code point (requires fromCodePoint, not fromCharCode)', () => {
        // U+1F600 is the grinning face emoji — above the BMP (> 0xFFFF)
        expect(decodeHtmlEntities('&#128512;')).toBe('😀');
    });

    test('returns empty string for out-of-range numeric entity (> U+10FFFF)', () => {
        expect(decodeHtmlEntities('&#9999999;')).toBe('');
    });

    test('replaces Unicode line separator U+2028 with space', () => {
        expect(decodeHtmlEntities('\u2028')).toBe(' ');
    });

    test('replaces Unicode paragraph separator U+2029 with space', () => {
        expect(decodeHtmlEntities('\u2029')).toBe(' ');
    });

    test('leaves plain text unchanged', () => {
        expect(decodeHtmlEntities('Hello World')).toBe('Hello World');
    });

    test('decodes multiple entities in one string', () => {
        expect(decodeHtmlEntities('&lt;b&gt;Hello &amp; World&lt;/b&gt;')).toBe('<b>Hello & World</b>');
    });
});

describe('normalizeText', () => {
    test('collapses multiple spaces into one', () => {
        expect(normalizeText('hello  world')).toBe('hello world');
    });

    test('removes space before comma', () => {
        expect(normalizeText('hello , world')).toBe('hello, world');
    });

    test('removes space before period', () => {
        expect(normalizeText('hello .')).toBe('hello.');
    });

    test('removes space before exclamation mark', () => {
        expect(normalizeText('wow !')).toBe('wow!');
    });

    test('removes space before semicolon', () => {
        expect(normalizeText('wait ; ok')).toBe('wait; ok');
    });

    test('replaces non-breaking space with regular space', () => {
        expect(normalizeText('a\u00a0b')).toBe('a b');
    });

    test('trims leading and trailing whitespace', () => {
        expect(normalizeText('  hello  ')).toBe('hello');
    });

    test('handles already clean text unchanged', () => {
        expect(normalizeText('hello world')).toBe('hello world');
    });
});

describe('cleanSegmentText', () => {
    test('removes bracket content when removeBrackets=true', () => {
        expect(cleanSegmentText('[inaudible]', { removeBrackets: true })).toBe('');
    });

    test('removes bracket annotation from middle of text', () => {
        expect(cleanSegmentText('Hello [music] world', { removeBrackets: true })).toBe('Hello world');
    });

    test('keeps brackets when removeBrackets=false', () => {
        expect(cleanSegmentText('[inaudible]', { removeBrackets: false })).toBe('[inaudible]');
    });

    test('removes ALL-CAPS single-word speaker label', () => {
        expect(cleanSegmentText('SPEAKER: Hello there', { removeBrackets: true })).toBe('Hello there');
    });

    test('removes ALL-CAPS multi-word speaker label', () => {
        expect(cleanSegmentText('JOHN DOE: Hello', { removeBrackets: true })).toBe('Hello');
    });

    test('does not remove mixed-case label', () => {
        expect(cleanSegmentText('Speaker: Hello', { removeBrackets: true })).toBe('Speaker: Hello');
    });

    test('does not remove two-character ALL-CAPS label (too short)', () => {
        expect(cleanSegmentText('AB: Hello', { removeBrackets: true })).toBe('AB: Hello');
    });

    test('returns empty string for empty input', () => {
        expect(cleanSegmentText('', { removeBrackets: true })).toBe('');
    });

    test('returns empty string for null input', () => {
        expect(cleanSegmentText(null, { removeBrackets: true })).toBe('');
    });

    test('normalizes extra whitespace in output', () => {
        expect(cleanSegmentText('  hello   world  ', { removeBrackets: true })).toBe('hello world');
    });
});

describe('normalizePreferredLanguage', () => {
    test('returns [] for null', () => {
        expect(normalizePreferredLanguage(null)).toEqual([]);
    });

    test('returns [] for undefined', () => {
        expect(normalizePreferredLanguage(undefined)).toEqual([]);
    });

    test('returns [] for empty string', () => {
        expect(normalizePreferredLanguage('')).toEqual([]);
    });

    test('wraps a single string in an array', () => {
        expect(normalizePreferredLanguage('en')).toEqual(['en']);
    });

    test('returns array as-is when all values are truthy', () => {
        expect(normalizePreferredLanguage(['en', 'fr'])).toEqual(['en', 'fr']);
    });

    test('filters falsy values from array', () => {
        expect(normalizePreferredLanguage(['en', null, '', 'fr'])).toEqual(['en', 'fr']);
    });

    test('returns [] for number input', () => {
        expect(normalizePreferredLanguage(42)).toEqual([]);
    });

    test('returns [] for empty array', () => {
        expect(normalizePreferredLanguage([])).toEqual([]);
    });
});

describe('normalizeBlockedReason', () => {
    test('returns "429" when HTTP 429 appears in stderr', () => {
        expect(normalizeBlockedReason('ERROR: HTTP Error 429: Too Many Requests')).toBe('429');
    });

    test('returns "429" for "too many requests" phrase', () => {
        expect(normalizeBlockedReason('too many requests from your IP')).toBe('429');
    });

    test('returns "captcha" when captcha is mentioned', () => {
        expect(normalizeBlockedReason('Please complete the captcha to continue')).toBe('captcha');
    });

    test('returns "signin_required" for "sign in to confirm" phrase', () => {
        expect(normalizeBlockedReason('Sign in to confirm your age')).toBe('signin_required');
    });

    test('returns "signin_required" for generic "sign in" mention', () => {
        expect(normalizeBlockedReason('Please sign in to continue')).toBe('signin_required');
    });

    test('returns "consent_loop" when both "consent" and "loop" appear', () => {
        expect(normalizeBlockedReason('Detected consent loop on the page')).toBe('consent_loop');
    });

    test('does not return "consent_loop" when only "consent" appears', () => {
        expect(normalizeBlockedReason('consent required')).toBe('unknown');
    });

    test('returns "unknown" for unrecognized error message', () => {
        expect(normalizeBlockedReason('Something went wrong unexpectedly')).toBe('unknown');
    });

    test('returns "unknown" for empty string', () => {
        expect(normalizeBlockedReason('')).toBe('unknown');
    });

    test('returns "unknown" when called with no argument', () => {
        expect(normalizeBlockedReason()).toBe('unknown');
    });

    test('matching is case-insensitive', () => {
        expect(normalizeBlockedReason('HTTP 429 ERROR')).toBe('429');
    });
});

describe('parseMetadataLine', () => {
    test('parses all four fields from a tab-delimited line', () => {
        const result = parseMetadataLine('My Title\tMy Channel\t305\t20231015');
        expect(result).toEqual({
            title: 'My Title',
            channelName: 'My Channel',
            durationSec: 305,
            uploadDate: '2023-10-15',
        });
    });

    test('converts YYYYMMDD upload date to YYYY-MM-DD', () => {
        expect(parseMetadataLine('T\tC\t60\t20200101').uploadDate).toBe('2020-01-01');
    });

    test('returns null for yt-dlp "NA" field values', () => {
        const result = parseMetadataLine('NA\tNA\tNA\tNA');
        expect(result.title).toBeNull();
        expect(result.channelName).toBeNull();
        expect(result.durationSec).toBeNull();
        expect(result.uploadDate).toBeNull();
    });

    test('returns null durationSec for non-numeric duration', () => {
        expect(parseMetadataLine('T\tC\tnot-a-number\t20231015').durationSec).toBeNull();
    });

    test('handles fractional duration (float seconds)', () => {
        expect(parseMetadataLine('T\tC\t90.5\t20231015').durationSec).toBeCloseTo(90.5);
    });

    test('returns nulls for empty input', () => {
        const result = parseMetadataLine('');
        expect(result.title).toBeNull();
        expect(result.channelName).toBeNull();
        expect(result.durationSec).toBeNull();
        expect(result.uploadDate).toBeNull();
    });

    test('trims whitespace from title and channel fields', () => {
        const result = parseMetadataLine('  My Title  \t  My Channel  \t120\t20231015');
        expect(result.title).toBe('My Title');
        expect(result.channelName).toBe('My Channel');
    });

    test('handles upload date that is not 8 digits (leaves as-is)', () => {
        expect(parseMetadataLine('T\tC\t60\t2023-10-15').uploadDate).toBe('2023-10-15');
    });
});
