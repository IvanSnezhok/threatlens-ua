import { describe, expect, it } from 'vitest';
import { estimateTokens, trimToTokens } from './token-estimate.js';

describe('estimateTokens', () => {
  it('is zero for nothing and grows with text, Cyrillic costing more than Latin', () => {
    expect(estimateTokens('')).toBe(0);
    const ukrainian = estimateTokens('Загроза ударних БпЛА для Полтавської області, курс на Кременчук.');
    const english = estimateTokens('Threat of strike UAVs for Poltava oblast, heading for Kremenchuk.');
    expect(ukrainian).toBeGreaterThan(english);
    // Generous on purpose: ~100 Cyrillic characters come out well above the ~30 tokens o200k would bill.
    expect(ukrainian).toBeGreaterThanOrEqual(25);
  });
});

describe('trimToTokens', () => {
  const lines = Array.from({ length: 50 }, (_, index) => `[2026-08-18 0${index % 10}:00] запис номер ${index} про Полтавщину`);
  const text = lines.join('\n');

  it('returns the text untouched when it fits', () => {
    expect(trimToTokens(text, 100_000)).toBe(text);
  });

  it('keeps the NEWEST lines — the tail — and cuts on a line boundary', () => {
    const trimmed = trimToTokens(text, 120);
    expect(trimmed.endsWith(lines[49]!)).toBe(true);
    expect(trimmed.startsWith('[2026-08-18')).toBe(true);
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(120);
    expect(trimmed.split('\n').length).toBeLessThan(lines.length);
  });

  it('never returns an empty string for a non-empty input', () => {
    expect(trimToTokens('один дуже довгий рядок '.repeat(200), 5).length).toBeGreaterThan(0);
  });
});
