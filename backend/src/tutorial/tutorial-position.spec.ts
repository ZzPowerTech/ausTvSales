import { byStepOrder, type TutorialCatalogue } from './tutorial-catalogue';
import type { PlayerdataProgress, QuestProgress } from './tutorial-playerdata';
import { readPosition } from './tutorial-position';

const PREMIUM = '11111111-1111-4111-8111-111111111111';
const BEDROCK = '00000000-0000-0000-0009-111111111111';

function catalogueOf(
  ids: string[],
  finalQuestId = '33tutorial',
): TutorialCatalogue {
  const sorted = [...ids].sort(byStepOrder);
  const set = new Set(sorted);
  const order = new Map(sorted.map((id, index) => [id, index]));
  return {
    ids: sorted,
    has: (id) => set.has(id),
    orderOf: (id) => order.get(id) ?? null,
    finalQuestId,
  };
}

const CATALOGUE = catalogueOf([
  '01tutorial',
  '02tutorial',
  '03tutorial',
  '10tutorial',
  '33tutorial',
]);

function quest(over: Partial<QuestProgress> = {}): QuestProgress {
  return {
    questId: '01tutorial',
    completed: false,
    startedAt: Date.parse('2026-03-10T15:00:00Z'),
    completedAt: null,
    ...over,
  };
}

function progress(quests: QuestProgress[]): PlayerdataProgress {
  return { quests };
}

describe('byStepOrder', () => {
  it('compares the numeric prefix as a number, not as text', () => {
    // The bug this closes is silent and total: a plain string sort puts
    // `10tutorial` before `2tutorial`, so every index derived from it is wrong
    // and "how far did this player get" answers something else entirely.
    expect(['10tutorial', '2tutorial', '1tutorial'].sort(byStepOrder)).toEqual([
      '1tutorial',
      '2tutorial',
      '10tutorial',
    ]);
  });

  it('keeps zero-padded ids in their obvious order', () => {
    expect(
      ['33tutorial', '01tutorial', '10tutorial'].sort(byStepOrder),
    ).toEqual(['01tutorial', '10tutorial', '33tutorial']);
  });

  it('sorts an id with no numeric prefix after the numbered ones', () => {
    expect(['bonus', '02tutorial'].sort(byStepOrder)).toEqual([
      '02tutorial',
      'bonus',
    ]);
  });

  it('keeps a branch beside the step it branches from', () => {
    expect(
      ['10tutorial-2', '03tutorial', '10tutorial'].sort(byStepOrder),
    ).toEqual(['03tutorial', '10tutorial', '10tutorial-2']);
  });
});

describe('readPosition', () => {
  it('returns null for a player who never touched the tutorial', () => {
    // Absent from the table rather than present with zeros: a row exists to say
    // where somebody got to, and "nowhere" is the absence of a row.
    const player = progress([quest({ questId: 'daily-fishing' })]);

    expect(readPosition(PREMIUM, player, CATALOGUE)).toBeNull();
  });

  it('takes the furthest quest by step order, including one merely started', () => {
    // "Stuck on step 3" means step 3 was started and not finished. The question
    // the spec asks is where they stopped, not what they last finished.
    const player = progress([
      quest({ questId: '01tutorial', completed: true }),
      quest({ questId: '02tutorial', completed: true }),
      quest({ questId: '03tutorial', completed: false }),
    ]);

    expect(readPosition(PREMIUM, player, CATALOGUE)).toMatchObject({
      furthestQuestId: '03tutorial',
      furthestIndex: 2,
      questsTouched: 3,
      questsCompleted: 2,
      completedTutorial: false,
    });
  });

  it('is not confused by the order the quests appear in the file', () => {
    const player = progress([
      quest({ questId: '10tutorial' }),
      quest({ questId: '01tutorial' }),
    ]);

    expect(readPosition(PREMIUM, player, CATALOGUE)?.furthestQuestId).toBe(
      '10tutorial',
    );
  });

  it('marks completion only for the configured final quest', () => {
    const notFinal = progress([
      quest({ questId: '10tutorial', completed: true }),
    ]);
    const final = progress([quest({ questId: '33tutorial', completed: true })]);

    expect(readPosition(PREMIUM, notFinal, CATALOGUE)?.completedTutorial).toBe(
      false,
    );
    expect(readPosition(PREMIUM, final, CATALOGUE)?.completedTutorial).toBe(
      true,
    );
  });

  it('ignores quests that are not in the catalogue', () => {
    const player = progress([
      quest({ questId: '01tutorial' }),
      quest({ questId: 'evento-natal' }),
      quest({ questId: 'daily-mining' }),
    ]);

    expect(readPosition(PREMIUM, player, CATALOGUE)?.questsTouched).toBe(1);
  });

  it('derives the platform from the uuid, like everything else (ADR-003)', () => {
    const player = progress([quest()]);

    expect(readPosition(BEDROCK, player, CATALOGUE)?.platform).toBe('bedrock');
    expect(readPosition(PREMIUM, player, CATALOGUE)?.platform).toBe(
      'java_premium',
    );
  });

  it('takes the earliest start across quests as the entry day', () => {
    const player = progress([
      quest({
        questId: '03tutorial',
        startedAt: Date.parse('2026-03-12T15:00:00Z'),
      }),
      quest({
        questId: '01tutorial',
        startedAt: Date.parse('2026-03-10T15:00:00Z'),
      }),
    ]);

    expect(readPosition(PREMIUM, player, CATALOGUE)?.enteredOn).toBe(
      '2026-03-10',
    );
  });

  it('still returns a position when no quest carries a usable date', () => {
    // "We do not know when" is not "it did not happen" — the same rule the
    // funnel applies, and the reason `enteredOn` is nullable rather than the
    // row being dropped.
    const player = progress([quest({ startedAt: null })]);

    const position = readPosition(PREMIUM, player, CATALOGUE);
    expect(position).not.toBeNull();
    expect(position?.enteredOn).toBeNull();
    expect(position?.questsTouched).toBe(1);
  });

  it('buckets the entry day in São Paulo, not in UTC', () => {
    // 2026-03-11 01:00 UTC is 2026-03-10 22:00 BRT.
    const player = progress([
      quest({ startedAt: Date.parse('2026-03-11T01:00:00Z') }),
    ]);

    expect(readPosition(PREMIUM, player, CATALOGUE)?.enteredOn).toBe(
      '2026-03-10',
    );
  });
});
