import { ITEM_ID_PATTERN } from './create-item.dto';

/**
 * Tripwire for the `item_id` regex duplicated across the two builds.
 *
 * The pattern exists twice — here and in
 * `frontend/src/app/core/models/item.model.ts` — because the two projects have
 * separate builds and cannot share a constant. A matching spec on the frontend
 * side pins the same literal and the same cases. Changing either copy fails its
 * own suite, forcing whoever changed it to look at the other.
 *
 * This side is the authority: the API rejects what it rejects regardless of
 * what the dashboard believes. The frontend copy exists only to spare the admin
 * a round-trip on an obvious typo.
 */
describe('ITEM_ID_PATTERN', () => {
  it('is the exact literal the frontend mirrors', () => {
    // Keep in sync with frontend/src/app/core/models/item.model.ts
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
      expect(ITEM_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('rejects what would break the plugin command or the FK', () => {
    for (const id of [
      'caixa natal', // a space splits the plugin command's arguments
      '_leading', // must start with letter or digit
      '-leading',
      'acentuação',
      'com/barra',
      '',
    ]) {
      expect(ITEM_ID_PATTERN.test(id)).toBe(false);
    }
  });
});
