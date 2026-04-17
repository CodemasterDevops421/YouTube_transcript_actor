import { sanitizeProxyArg, sanitizeCommand, extractAvailableLanguages } from '../../src/utils.js';

describe('sanitizeProxyArg', () => {
    test('masks username and password in http proxy URL', () => {
        expect(sanitizeProxyArg('http://user:pass@proxy.example.com:8000'))
            .toBe('http://***:***@proxy.example.com:8000');
    });

    test('masks credentials in https proxy URL', () => {
        expect(sanitizeProxyArg('https://myuser:mypass@host.com:3128'))
            .toBe('https://***:***@host.com:3128');
    });

    test('leaves URL without credentials unchanged', () => {
        expect(sanitizeProxyArg('http://proxy.example.com:8000'))
            .toBe('http://proxy.example.com:8000');
    });

    test('is case-insensitive for the scheme', () => {
        expect(sanitizeProxyArg('HTTP://user:pass@proxy.com'))
            .toBe('HTTP://***:***@proxy.com');
    });

    test('masks credentials when password contains special characters', () => {
        expect(sanitizeProxyArg('http://user:p%40ss!word@proxy.com'))
            .toBe('http://***:***@proxy.com');
    });
});

describe('sanitizeCommand', () => {
    test('sanitizes proxy URL that follows --proxy flag', () => {
        const args = ['--skip-download', '--proxy', 'http://user:pass@proxy.com:8000', 'https://youtube.com'];
        const result = sanitizeCommand(args);
        expect(result[2]).toBe('http://***:***@proxy.com:8000');
    });

    test('leaves all other arguments unchanged', () => {
        const args = ['--skip-download', '--proxy', 'http://user:pass@proxy.com', 'https://youtube.com'];
        const result = sanitizeCommand(args);
        expect(result[0]).toBe('--skip-download');
        expect(result[3]).toBe('https://youtube.com');
    });

    test('does not mutate the original args array', () => {
        const args = ['--proxy', 'http://user:pass@proxy.com'];
        sanitizeCommand(args);
        expect(args[1]).toBe('http://user:pass@proxy.com');
    });

    test('returns a copy of args unchanged when no --proxy flag present', () => {
        const args = ['--skip-download', 'https://youtube.com'];
        expect(sanitizeCommand(args)).toEqual(args);
    });

    test('handles --proxy at end of args with no following value', () => {
        const args = ['--skip-download', '--proxy'];
        expect(() => sanitizeCommand(args)).not.toThrow();
        expect(sanitizeCommand(args)).toEqual(['--skip-download', '--proxy']);
    });
});

describe('extractAvailableLanguages', () => {
    test('extracts language codes separated by two or more spaces', () => {
        const output = 'en  English\nfr  French\nde  German';
        expect(extractAvailableLanguages(output)).toEqual(['en', 'fr', 'de']);
    });

    test('returns empty array for empty output', () => {
        expect(extractAvailableLanguages('')).toEqual([]);
    });

    test('ignores lines with only a single space before label', () => {
        const output = 'en English\nfr French';
        expect(extractAvailableLanguages(output)).toEqual([]);
    });

    test('deduplicates repeated language codes', () => {
        const output = 'en  English\nen  English (auto-generated)';
        expect(extractAvailableLanguages(output)).toEqual(['en']);
    });

    test('handles hyphenated locale codes like en-US and zh-CN', () => {
        const output = 'en-US  English (United States)\nzh-CN  Chinese Simplified';
        const result = extractAvailableLanguages(output);
        expect(result).toContain('en-US');
        expect(result).toContain('zh-CN');
    });

    test('handles realistic yt-dlp --list-subs output with info header lines', () => {
        // Real yt-dlp output uses single-space or bracket-prefixed headers that don't match
        const output = `
[info] Available subtitles for dQw4w9WgXcQ:
Language formats
en  vtt, ttml
fr  vtt, ttml
`;
        // "[info]..." and "Language formats" (single space) don't match; only "en" and "fr" do
        const result = extractAvailableLanguages(output);
        expect(result).toContain('en');
        expect(result).toContain('fr');
        expect(result).not.toContain('[info]');
    });
});
