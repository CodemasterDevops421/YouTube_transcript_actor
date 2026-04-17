import { extractVideoId, canonicalWatchUrl } from '../../src/utils.js';

describe('extractVideoId', () => {
    test('extracts ID from standard watch URL', () => {
        expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    test('extracts ID from youtube.com without www', () => {
        expect(extractVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    test('extracts ID from mobile URL', () => {
        expect(extractVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    test('extracts ID from youtu.be shortlink', () => {
        expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    test('extracts ID from youtu.be shortlink with query params', () => {
        expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
    });

    test('extracts ID from /shorts/ URL', () => {
        expect(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    test('slices watch URL video ID to 11 characters', () => {
        expect(extractVideoId('https://www.youtube.com/watch?v=ABCDEFGHIJK_extra')).toBe('ABCDEFGHIJK');
    });

    test('slices youtu.be video ID to 11 characters', () => {
        expect(extractVideoId('https://youtu.be/ABCDEFGHIJK_extra')).toBe('ABCDEFGHIJK');
    });

    test('slices /shorts/ video ID to 11 characters', () => {
        expect(extractVideoId('https://www.youtube.com/shorts/ABCDEFGHIJK_extra')).toBe('ABCDEFGHIJK');
    });

    test('returns null for non-YouTube domain', () => {
        expect(extractVideoId('https://vimeo.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    });

    test('returns null for invalid URL string', () => {
        expect(extractVideoId('not-a-url')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(extractVideoId('')).toBeNull();
    });

    test('returns null when v param is missing from /watch', () => {
        expect(extractVideoId('https://www.youtube.com/watch')).toBeNull();
    });

    test('returns null for unrecognized YouTube path like /channel/', () => {
        expect(extractVideoId('https://www.youtube.com/channel/UCxxxxxx')).toBeNull();
    });

    test('returns null for YouTube homepage', () => {
        expect(extractVideoId('https://www.youtube.com/')).toBeNull();
    });
});

describe('canonicalWatchUrl', () => {
    test('formats video ID into canonical watch URL', () => {
        expect(canonicalWatchUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });
});
