import { ITEM_ID_PATTERN } from './item.model';

/**
 * Tripwire for the `item_id` regex duplicated across the two builds.
 *
 * The frontend cannot import from `backend/`, so the pattern exists twice:
 * here and in `backend/src/items/dto/create-item.dto.ts`. A matching spec on
 * the backend side pins the same literal and the same cases. Changing either
 * copy fails its own suite, which forces whoever changed it to look at the
 * other — the closest thing to a shared source of truth without a shared build.
 *
 * If these ever diverge silently, the symptom is nasty and quiet: the dashboard
 * rejects an id the API would have accepted (or waves through one it rejects),
 * and the admin gets a validation error with no round-trip to explain it.
 */
describe('ITEM_ID_PATTERN', () => {
  it('is the exact literal the backend uses', () => {
    // Keep in sync with backend/src/items/dto/create-item.dto.ts
    expect(ITEM_ID_PATTERN.source).toBe('^[A-Za-z0-9][A-Za-z0-9_-]*$');
  });

  it('accepts the identifier shapes the catalog actually uses', () => {
    for (const id of [
      'caixaNatal2026',
      'vipGold',
      'item_com_underscore',
      'item-com-hifen',
      'A1',
      '2026caixa',
    ]) {
      expect(ITEM_ID_PATTERN.test(id)).withContext(id).toBeTrue();
    }
  });

  it('rejects what would break the plugin command or the FK', () => {
    for (const id of [
      'caixa natal', // space splits the command arguments
      '_leading', // must start with letter or digit
      '-leading',
      'acentuação',
      'com/barra',
      '',
    ]) {
      expect(ITEM_ID_PATTERN.test(id)).withContext(id).toBeFalse();
    }
  });
});
