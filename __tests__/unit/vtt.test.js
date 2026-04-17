import { parseTimestamp, parseVtt, dedupeSegments, buildTranscriptText } from '../../src/utils.js';

describe('parseTimestamp', () => {
    test('parses HH:MM:SS into total seconds', () => {
        expect(parseTimestamp('00:01:30')).toBe(90);
    });

    test('parses hours correctly', () => {
        expect(parseTimestamp('01:00:00')).toBe(3600);
    });

    test('parses fractional seconds', () => {
        expect(parseTimestamp('00:00:01.500')).toBeCloseTo(1.5);
    });

    test('parses a complex timestamp with hours, minutes, and fractional seconds', () => {
        expect(parseTimestamp('02:30:15.123')).toBeCloseTo(9015.123);
    });

    test('returns null for invalid format', () => {
        expect(parseTimestamp('invalid')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(parseTimestamp('')).toBeNull();
    });
});

describe('parseVtt', () => {
    const BASIC_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
This is a test
`;

    test('parses segment text correctly', () => {
        const segs = parseVtt(BASIC_VTT);
        expect(segs[0].text).toBe('Hello world');
        expect(segs[1].text).toBe('This is a test');
    });

    test('parses start timestamps into seconds', () => {
        const segs = parseVtt(BASIC_VTT);
        expect(segs[0].startSec).toBe(1);
        expect(segs[1].startSec).toBe(5);
    });

    test('computes durSec as end minus start', () => {
        const segs = parseVtt(BASIC_VTT);
        expect(segs[0].durSec).toBe(3);
        expect(segs[1].durSec).toBe(3);
    });

    test('skips WEBVTT header, Kind, and Language lines', () => {
        const segs = parseVtt(BASIC_VTT);
        expect(segs.every((s) => !['WEBVTT', 'Kind: captions', 'Language: en'].includes(s.text))).toBe(true);
    });

    test('strips HTML tags from segment text', () => {
        const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<b>Hello</b> <i>world</i>\n';
        const segs = parseVtt(vtt);
        expect(segs[0].text).toBe('Hello world');
    });

    test('removes bracket content when removeBrackets=true', () => {
        const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n[Music] Hello there\n';
        const segs = parseVtt(vtt, { removeBrackets: true });
        expect(segs[0].text).toBe('Hello there');
    });

    test('keeps brackets when removeBrackets=false', () => {
        const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n[Music] Hello there\n';
        const segs = parseVtt(vtt, { removeBrackets: false });
        expect(segs[0].text).toBe('[Music] Hello there');
    });

    test('decodes HTML entities in segment text', () => {
        const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nTom &amp; Jerry\n';
        const segs = parseVtt(vtt);
        expect(segs[0].text).toBe('Tom & Jerry');
    });

    test('handles CRLF line endings', () => {
        const vtt = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:04.000\r\nHello world\r\n';
        const segs = parseVtt(vtt);
        expect(segs[0].text).toBe('Hello world');
    });

    test('returns empty array for VTT with no cues', () => {
        expect(parseVtt('WEBVTT\n\n')).toEqual([]);
    });

    test('joins multi-line cues into a single text with space', () => {
        const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nFirst line\nSecond line\n';
        const segs = parseVtt(vtt);
        expect(segs[0].text).toBe('First line Second line');
    });

    test('durSec is 0 when end equals start (no negative durations)', () => {
        const vtt = 'WEBVTT\n\n00:00:03.000 --> 00:00:03.000\nInstant cue\n';
        const segs = parseVtt(vtt);
        expect(segs[0].durSec).toBe(0);
    });
});

describe('dedupeSegments', () => {
    test('removes segments with duplicate text', () => {
        const segs = [
            { text: 'Hello', startSec: 0 },
            { text: 'World', startSec: 1 },
            { text: 'Hello', startSec: 2 },
        ];
        expect(dedupeSegments(segs)).toHaveLength(2);
    });

    test('keeps the first occurrence of duplicate text, not subsequent ones', () => {
        const segs = [
            { text: 'Hello', startSec: 0 },
            { text: 'World', startSec: 1 },
            { text: 'Hello', startSec: 5 },
        ];
        const result = dedupeSegments(segs);
        expect(result[0].startSec).toBe(0);
        expect(result[1].text).toBe('World');
    });

    test('preserves insertion order of first occurrences', () => {
        const segs = [
            { text: 'B', startSec: 0 },
            { text: 'A', startSec: 1 },
            { text: 'B', startSec: 2 },
        ];
        expect(dedupeSegments(segs).map((s) => s.text)).toEqual(['B', 'A']);
    });

    test('skips segments with empty text', () => {
        const segs = [{ text: '' }, { text: 'Hello' }];
        const result = dedupeSegments(segs);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('Hello');
    });

    test('skips segments with null text', () => {
        const segs = [{ text: null }, { text: 'Hello' }];
        expect(dedupeSegments(segs)).toHaveLength(1);
    });

    test('returns empty array for empty input', () => {
        expect(dedupeSegments([])).toEqual([]);
    });

    test('returns all segments when there are no duplicates', () => {
        const segs = [{ text: 'A' }, { text: 'B' }, { text: 'C' }];
        expect(dedupeSegments(segs)).toHaveLength(3);
    });
});

describe('buildTranscriptText', () => {
    const segs = [{ text: 'Hello' }, { text: 'world' }, { text: 'test' }];

    test('joins with space by default', () => {
        expect(buildTranscriptText(segs)).toBe('Hello world test');
    });

    test('joins with space when joinWith="space"', () => {
        expect(buildTranscriptText(segs, 'space')).toBe('Hello world test');
    });

    test('joins with newline when joinWith="newline"', () => {
        expect(buildTranscriptText(segs, 'newline')).toBe('Hello\nworld\ntest');
    });

    test('returns empty string for empty segments array', () => {
        expect(buildTranscriptText([])).toBe('');
    });

    test('trims leading and trailing whitespace from result', () => {
        expect(buildTranscriptText([{ text: '  Hello  ' }])).toBe('Hello');
    });

    test('single segment returns just its text', () => {
        expect(buildTranscriptText([{ text: 'Only one' }])).toBe('Only one');
    });
});
