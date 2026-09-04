import { describe, expect, it } from 'vitest';
import { playingItemKey } from './item-key.js';
import type { PlayingItem } from './state.js';

const item = (overrides: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Velocity Division',
  subtitle: 'Nitrous Cartel',
  durationMs: 210_000,
  images: [],
  isLocal: false,
  ...overrides,
});

describe('playingItemKey', () => {
  it('is null when nothing is playing', () => {
    expect(playingItemKey(null)).toBeNull();
  });

  it('prefers the id', () => {
    expect(playingItemKey(item())).toBe('track-1');
  });

  it('falls back to the uri when there is no id', () => {
    expect(playingItemKey(item({ id: null }))).toBe('spotify:track:track-1');
  });

  // Local files carry neither an id nor a uri. Without a fallback every poll of
  // one looks like a different track, resetting the progress bar constantly.
  it('identifies a local file by title and duration', () => {
    const local = item({ id: null, uri: null, isLocal: true });
    expect(playingItemKey(local)).toBe('local:Velocity Division:210000');
  });

  it('distinguishes two local files of the same name by duration', () => {
    const a = item({ id: null, uri: null, title: 'Untitled', durationMs: 1000 });
    const b = item({ id: null, uri: null, title: 'Untitled', durationMs: 2000 });
    expect(playingItemKey(a)).not.toBe(playingItemKey(b));
  });

  it('gives the same key for the same item across polls', () => {
    expect(playingItemKey(item())).toBe(playingItemKey(item()));
  });
});
