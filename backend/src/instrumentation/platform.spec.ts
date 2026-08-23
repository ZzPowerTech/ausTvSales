import { Platform, platformOf } from './platform';

describe('platformOf (ADR-003)', () => {
  describe('bedrock', () => {
    it('recognises the Floodgate prefix', () => {
      expect(platformOf('00000000-0000-0000-0009-01f4a3b2c1d0')).toBe(
        Platform.Bedrock,
      );
    });

    it('checks bedrock before the version nibble', () => {
      // A Floodgate UUID carries `0` in the version position and would fall
      // through to `unknown` if the order were reversed.
      const floodgate = '00000000-0000-0000-0009-000000000001';
      expect(floodgate[14]).toBe('0');
      expect(platformOf(floodgate)).toBe(Platform.Bedrock);
    });
  });

  describe('java', () => {
    it('reads version 3 as offline', () => {
      expect(platformOf('a1b2c3d4-e5f6-3789-abcd-ef0123456789')).toBe(
        Platform.JavaOffline,
      );
    });

    it('reads version 4 as premium', () => {
      expect(platformOf('a1b2c3d4-e5f6-4789-abcd-ef0123456789')).toBe(
        Platform.JavaPremium,
      );
    });

    it('reads the nibble at index 14, matching SUBSTRING(uuid,15,1)', () => {
      const uuid = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
      // SQL is 1-based, JavaScript is 0-based. The off-by-one between the two
      // spellings of this rule has bitten people porting it before.
      expect(uuid[14]).toBe('4');
      expect(platformOf(uuid)).toBe(Platform.JavaPremium);
    });
  });

  describe('normalizacao', () => {
    it('is case-insensitive', () => {
      expect(platformOf('A1B2C3D4-E5F6-3789-ABCD-EF0123456789')).toBe(
        Platform.JavaOffline,
      );
    });

    it('tolerates surrounding whitespace', () => {
      expect(platformOf('  a1b2c3d4-e5f6-4789-abcd-ef0123456789  ')).toBe(
        Platform.JavaPremium,
      );
    });
  });

  describe('entrada irreconhecivel', () => {
    it.each([
      [null],
      [undefined],
      [''],
      ['nao-e-uuid'],
      ['a1b2c3d4-e5f6'],
      ['a1b2c3d4-e5f6-9789-abcd-ef0123456789'],
    ])('returns unknown for %p instead of guessing', (input) => {
      // Never folded into a real bucket. A platform metric that quietly absorbs
      // malformed input cannot be trusted to answer the question it exists for —
      // whether bot traffic is inflating acquisition.
      expect(platformOf(input as string | null)).toBe(Platform.Unknown);
    });

    it('does not read past the end of a truncated uuid', () => {
      expect(platformOf('a1b2c3d4-e5f6-')).toBe(Platform.Unknown);
    });

    it('rejects a non-string without throwing', () => {
      expect(platformOf(42 as unknown as string)).toBe(Platform.Unknown);
      expect(platformOf({} as unknown as string)).toBe(Platform.Unknown);
    });
  });

  describe('as tres classes sao mutuamente exclusivas', () => {
    it('assigns exactly one platform per uuid', () => {
      const samples = [
        '00000000-0000-0000-0009-01f4a3b2c1d0',
        'a1b2c3d4-e5f6-3789-abcd-ef0123456789',
        'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
      ];
      const results = samples.map(platformOf);

      expect(new Set(results).size).toBe(3);
      expect(results).not.toContain(Platform.Unknown);
    });
  });
});
