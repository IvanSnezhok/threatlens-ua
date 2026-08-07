import { describe, expect, it } from 'vitest';
import { createChannelSchema, updateChannelSchema } from './recommended-channels.js';

describe('recommended Telegram channel validation', () => {
  it('normalizes an @username or t.me URL', () => {
    const base = { title: 'Повітряні Сили', description: '', category: 'official' as const,
      locationId: null, verified: true, active: true, sortOrder: 10 };
    expect(createChannelSchema.parse({ ...base, username: '@kpszsu' }).username).toBe('kpszsu');
    expect(createChannelSchema.parse({ ...base, username: 'https://t.me/kpszsu/' }).username).toBe('kpszsu');
  });

  it('rejects non-Telegram URLs and empty updates', () => {
    expect(() => createChannelSchema.parse({ title: 'Channel', username: 'https://example.com/x',
      description: '', category: 'monitoring', locationId: null, verified: false, active: true, sortOrder: 100 })).toThrow();
    expect(() => updateChannelSchema.parse({})).toThrow();
  });
});
