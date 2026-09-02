import { Platform } from '../instrumentation/platform';
import {
  aggregate,
  readContribution,
  uuidFromFileName,
  type PlayerContribution,
} from './tutorial-aggregate';
import type { TutorialCatalogue } from './tutorial-catalogue';
import type { PlayerdataProgress } from './tutorial-playerdata';

function catalogueOf(
  ids: string[],
  finalQuestId = '33tutorial',
): TutorialCatalogue {
  const set = new Set(ids);
  const order = new Map(ids.map((id, index) => [id, index]));
  return {
    ids,
    has: (id) => set.has(id),
    orderOf: (id) => order.get(id) ?? null,
    finalQuestId,
  };
}

const CATALOGUE = catalogueOf([
  '01tutorial',
  '02tutorial',
  '04-2tutorial',
  '33tutorial',
]);

/** Real uuids by shape (ADR-003), so `platform` is exercised for real. */
const BEDROCK = '00000000-0000-0000-0009-0000000abcde';
const JAVA_PREMIUM = '11111111-2222-4333-8444-555555555555';
const JAVA_OFFLINE = '11111111-2222-3333-8444-555555555555';

/** 2026-03-10 12:00:00 BRT. */
const MARCH_10_NOON = Date.UTC(2026, 2, 10, 15, 0, 0);
/** 2026-03-10 21:00:00 BRT — which is 2026-03-11 in UTC. */
const MARCH_10_EVENING = Date.UTC(2026, 2, 11, 0, 0, 0);

function progress(quests: PlayerdataProgress['quests']): PlayerdataProgress {
  return { quests };
}

describe('readContribution', () => {
  it('dates entry by the earliest tutorial quest, not by 01tutorial', () => {
    // Hardcoding the first step would miss anyone who reached the tutorial
    // through a branch. The catalogue already says which quests are tutorial
    // ones, so the earliest of those is the more robust spelling of the same
    // number — in the 2026-08-19 baseline the two counts coincide exactly.
    const result = readContribution(
      JAVA_PREMIUM,
      progress([
        {
          questId: '04-2tutorial',
          startedAt: MARCH_10_NOON,
          completed: false,
          completedAt: null,
        },
        {
          questId: '02tutorial',
          startedAt: MARCH_10_NOON + 86_400_000,
          completed: false,
          completedAt: null,
        },
      ]),
      CATALOGUE,
    );

    expect(result.enteredOn).toBe('2026-03-10');
    expect(result.touchedTutorial).toBe(true);
  });

  it('ignores quests outside the tutorial catalogue', () => {
    // The same file holds daily quests and seasonal events. Counting them would
    // report the whole player base as tutorial entrants.
    const result = readContribution(
      JAVA_PREMIUM,
      progress([
        {
          questId: 'diario_escavacao',
          startedAt: MARCH_10_NOON,
          completed: true,
          completedAt: MARCH_10_NOON,
        },
      ]),
      CATALOGUE,
    );

    expect(result.touchedTutorial).toBe(false);
    expect(result.enteredOn).toBeNull();
  });

  it('counts an undated entry as an entry, without giving it a day', () => {
    // "We do not know when" is not "it did not happen". The dated series drops
    // the player for want of a day; the total must not pretend they never came.
    const result = readContribution(
      JAVA_PREMIUM,
      progress([
        {
          questId: '01tutorial',
          startedAt: null,
          completed: false,
          completedAt: null,
        },
      ]),
      CATALOGUE,
    );

    expect(result.touchedTutorial).toBe(true);
    expect(result.enteredOn).toBeNull();
  });

  it('counts completion only for the configured final quest', () => {
    const result = readContribution(
      JAVA_PREMIUM,
      progress([
        {
          questId: '02tutorial',
          startedAt: MARCH_10_NOON,
          completed: true,
          completedAt: MARCH_10_NOON,
        },
      ]),
      CATALOGUE,
    );

    // Finishing step 2 of 41 is not finishing the tutorial.
    expect(result.completedOn).toBeNull();
  });

  it('counts completion of the final quest, dated by completion-date', () => {
    const result = readContribution(
      BEDROCK,
      progress([
        {
          questId: '01tutorial',
          startedAt: MARCH_10_NOON,
          completed: true,
          completedAt: MARCH_10_NOON,
        },
        {
          questId: '33tutorial',
          startedAt: MARCH_10_NOON,
          completed: true,
          completedAt: MARCH_10_NOON + 86_400_000,
        },
      ]),
      CATALOGUE,
    );

    expect(result.completedOn).toBe('2026-03-11');
    expect(result.platform).toBe(Platform.Bedrock);
  });

  it('does not date a completion whose completion-date is missing', () => {
    // Older Quests versions did not always write the date. The completion is
    // real; only the dated series loses the row.
    const result = readContribution(
      JAVA_PREMIUM,
      progress([
        {
          questId: '33tutorial',
          startedAt: MARCH_10_NOON,
          completed: true,
          completedAt: null,
        },
      ]),
      CATALOGUE,
    );

    expect(result.completedOn).toBeNull();
    expect(result.enteredOn).toBe('2026-03-10');
  });

  it('derives platform from the uuid alone (ADR-003)', () => {
    const entry = progress([
      {
        questId: '01tutorial',
        startedAt: MARCH_10_NOON,
        completed: false,
        completedAt: null,
      },
    ]);

    expect(readContribution(BEDROCK, entry, CATALOGUE).platform).toBe(
      Platform.Bedrock,
    );
    expect(readContribution(JAVA_OFFLINE, entry, CATALOGUE).platform).toBe(
      Platform.JavaOffline,
    );
    expect(readContribution(JAVA_PREMIUM, entry, CATALOGUE).platform).toBe(
      Platform.JavaPremium,
    );
  });

  it('files a 21:00 BRT entry under that day, not the next one', () => {
    // The bug this guards is silent and one-directional: `toISOString()` would
    // file every Brazilian evening — the server's busiest hours — under the
    // following day, every single day.
    const result = readContribution(
      JAVA_PREMIUM,
      progress([
        {
          questId: '01tutorial',
          startedAt: MARCH_10_EVENING,
          completed: false,
          completedAt: null,
        },
      ]),
      CATALOGUE,
    );

    expect(new Date(MARCH_10_EVENING).toISOString()).toContain('2026-03-11');
    expect(result.enteredOn).toBe('2026-03-10');
  });
});

describe('aggregate', () => {
  const contribution = (
    over: Partial<PlayerContribution>,
  ): PlayerContribution => ({
    platform: Platform.JavaPremium,
    enteredOn: null,
    completedOn: null,
    touchedTutorial: false,
    ...over,
  });

  it('counts entries and completions per day and platform', () => {
    const rows = aggregate([
      contribution({ enteredOn: '2026-03-10', platform: Platform.Bedrock }),
      contribution({ enteredOn: '2026-03-10', platform: Platform.Bedrock }),
      contribution({ enteredOn: '2026-03-10', platform: Platform.JavaPremium }),
      contribution({
        enteredOn: '2026-03-11',
        completedOn: '2026-03-12',
        platform: Platform.Bedrock,
      }),
    ]);

    expect(rows).toEqual([
      { day: '2026-03-10', platform: 'bedrock', entered: 2, completed: 0 },
      { day: '2026-03-10', platform: 'java_premium', entered: 1, completed: 0 },
      { day: '2026-03-11', platform: 'bedrock', entered: 1, completed: 0 },
      { day: '2026-03-12', platform: 'bedrock', entered: 0, completed: 1 },
    ]);
  });

  it('files entry and completion on their own days', () => {
    // A player who enters in March and finishes in April is one entry in March
    // and one completion in April — never both on the same row.
    const rows = aggregate([
      contribution({ enteredOn: '2026-03-10', completedOn: '2026-04-02' }),
    ]);

    expect(rows).toEqual([
      { day: '2026-03-10', platform: 'java_premium', entered: 1, completed: 0 },
      { day: '2026-04-02', platform: 'java_premium', entered: 0, completed: 1 },
    ]);
  });

  it('emits no row for a player with no dated event', () => {
    // Not a zero row: absence and zero mean different things, and which one a
    // gap is gets answered by the sync record, never by this table.
    expect(aggregate([contribution({ touchedTutorial: true })])).toEqual([]);
  });

  it('returns rows in a deterministic order', () => {
    const rows = aggregate([
      contribution({ enteredOn: '2026-03-11', platform: Platform.JavaPremium }),
      contribution({ enteredOn: '2026-03-10', platform: Platform.Unknown }),
      contribution({ enteredOn: '2026-03-10', platform: Platform.Bedrock }),
    ]);

    expect(rows.map((r) => `${r.day} ${r.platform}`)).toEqual([
      '2026-03-10 bedrock',
      '2026-03-10 unknown',
      '2026-03-11 java_premium',
    ]);
  });
});

describe('uuidFromFileName', () => {
  it('accepts a playerdata file and normalises the case', () => {
    expect(uuidFromFileName('11111111-2222-4333-8444-555555555555.yml')).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
    expect(uuidFromFileName('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE.yml')).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });

  it('accepts the Floodgate prefix', () => {
    // Bedrock uuids have `0` in the version position. A regex written around
    // the version nibble would reject the entire Bedrock player base.
    expect(uuidFromFileName('00000000-0000-0000-0009-0000000abcde.yml')).toBe(
      '00000000-0000-0000-0009-0000000abcde',
    );
  });

  it.each([
    ['README.md'],
    ['backup.yml.bak'],
    ['nao-e-uuid.yml'],
    ['11111111-2222-4333-8444-555555555555.yml.bak'],
  ])('rejects %s rather than bucketing it as unknown', (name) => {
    // `platformOf` would return `unknown` for any of these, quietly inflating a
    // bucket whose meaning is "we could not tell".
    expect(uuidFromFileName(name)).toBeNull();
  });
});
