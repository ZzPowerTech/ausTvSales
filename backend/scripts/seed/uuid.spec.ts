import { deterministicUuid } from './uuid';

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deterministicUuid', () => {
  it('produz um UUID v5 bem formado', () => {
    expect(deterministicUuid('austv', 'sale', 0)).toMatch(UUID_V5);
  });

  it('e estavel para a mesma entrada — base da idempotencia do seed', () => {
    expect(deterministicUuid('austv', 'sale', 42)).toBe(
      deterministicUuid('austv', 'sale', 42),
    );
  });

  it('separa indices, tipos e seeds diferentes', () => {
    const ids = new Set([
      deterministicUuid('austv', 'sale', 1),
      deterministicUuid('austv', 'sale', 2),
      deterministicUuid('austv', 'player', 1),
      deterministicUuid('outra', 'sale', 1),
    ]);
    expect(ids.size).toBe(4);
  });
});
