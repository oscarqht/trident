import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatRelativeTime, formatFullDateTime, getRepositoryDisplayName } from './utils';
import type { Repository } from './types';

describe('formatRelativeTime', () => {
  it('should return "Never" for null, undefined, or invalid dates', () => {
    assert.strictEqual(formatRelativeTime(null), 'Never');
    assert.strictEqual(formatRelativeTime(undefined), 'Never');
    assert.strictEqual(formatRelativeTime(''), 'Never');
    assert.strictEqual(formatRelativeTime('not-a-date'), 'Never');
  });

  it('should return "Just now" for dates within 1 minute or future skew', () => {
    const now = Date.now();
    assert.strictEqual(formatRelativeTime(new Date(now - 10 * 1000).toISOString()), 'Just now');
    assert.strictEqual(formatRelativeTime(new Date(now + 5 * 1000).toISOString()), 'Just now');
  });

  it('should format minutes ago properly', () => {
    const now = Date.now();
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
    assert.strictEqual(formatRelativeTime(tenMinutesAgo), '10m ago');
  });

  it('should format hours ago properly', () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(formatRelativeTime(twoHoursAgo), '2h ago');
  });

  it('should format yesterday and days ago properly', () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(formatRelativeTime(oneDayAgo), 'Yesterday');

    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(formatRelativeTime(threeDaysAgo), '3d ago');
  });

  it('should format older dates with month and day (and year if different year)', () => {
    const oldDateSameYear = new Date(new Date().getFullYear(), 0, 15).toISOString();
    const formatted = formatRelativeTime(oldDateSameYear);
    assert.ok(formatted.includes('Jan'));

    const oldDateDiffYear = new Date(2020, 5, 20).toISOString();
    const formattedDiff = formatRelativeTime(oldDateDiffYear);
    assert.ok(formattedDiff.includes('2020'));
  });
});

describe('formatFullDateTime', () => {
  it('should return undefined for null, undefined, or invalid dates', () => {
    assert.strictEqual(formatFullDateTime(null), undefined);
    assert.strictEqual(formatFullDateTime(undefined), undefined);
    assert.strictEqual(formatFullDateTime('invalid'), undefined);
  });

  it('should return localized date string for valid dates', () => {
    const iso = '2026-09-28T10:00:00.000Z';
    const result = formatFullDateTime(iso);
    assert.ok(typeof result === 'string' && result.length > 0);
  });
});

describe('Repository sorting logic', () => {
  it('should sort repositories with lastOpenedAt descending, and untracked repos alphabetically at bottom', () => {
    const repos: Repository[] = [
      { path: '/b', name: 'beta' },
      { path: '/a', name: 'alpha' },
      { path: '/old', name: 'old-active', lastOpenedAt: '2026-09-20T10:00:00.000Z' },
      { path: '/new', name: 'new-active', lastOpenedAt: '2026-09-28T10:00:00.000Z' },
    ];

    const sorted = [...repos].sort((a, b) => {
      const aTime = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
      const bTime = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      const aName = getRepositoryDisplayName(a).toLowerCase();
      const bName = getRepositoryDisplayName(b).toLowerCase();
      return aName.localeCompare(bName);
    });

    assert.deepStrictEqual(sorted.map(r => r.name), [
      'new-active',
      'old-active',
      'alpha',
      'beta',
    ]);
  });
});
