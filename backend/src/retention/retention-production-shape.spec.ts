/**
 * The 2026-09-02 production read, replayed.
 *
 * Every other test in this module builds the smallest fixture that isolates one
 * rule. This one exists for the opposite reason: the span mechanism was written
 * against a specific dataset, tightened twice after review, and the question
 * "does it still do the right thing to the 45 cohorts it was written for?" has
 * no answer in a fixture of three.
 *
 * The shape is the real one — 45 cohorts, sizes verbatim, all of them surviving
 * at 100% on every horizon except `2025-08 / java_offline`, whose D30 is 96,7%.
 * That single exception is what makes the test worth having: it is a judgeable
 * cohort that PASSED inside a confirmed month, so it exercises the base of the
 * suppression claim (21 of 22, not 21 of 21) and the rule that a failing cohort
 * settles its month whatever else the month holds.
 */
import type { RetentionPlayer } from './plan-retention';
import {
  applyContaminatedSpans,
  buildCohorts,
  detectContaminatedSpans,
} from './retention-math';
import type { CohortOptions } from './retention-math';

const NOW = Date.parse('2026-09-02T12:00:00-03:00');

const UUID: Record<string, (n: number) => string> = {
  bedrock: (n) => `00000000-0000-0000-0009-${String(n).padStart(12, '0')}`,
  java_offline: (n) => `11111111-1111-3111-8111-${String(n).padStart(12, '0')}`,
  java_premium: (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
};

/** The 45 cohorts of the 2026-09-02 read, as (month, platform, size). */
const PRODUCTION: [string, string, number][] = [
  ['2024-06', 'bedrock', 58],
  ['2024-06', 'java_offline', 115],
  ['2024-06', 'java_premium', 114],
  ['2024-07', 'bedrock', 23],
  ['2024-07', 'java_offline', 36],
  ['2024-07', 'java_premium', 26],
  ['2024-08', 'bedrock', 16],
  ['2024-08', 'java_offline', 25],
  ['2024-08', 'java_premium', 18],
  ['2024-09', 'bedrock', 11],
  ['2024-09', 'java_offline', 16],
  ['2024-09', 'java_premium', 14],
  ['2024-10', 'bedrock', 13],
  ['2024-10', 'java_offline', 18],
  ['2024-10', 'java_premium', 14],
  ['2024-11', 'bedrock', 11],
  ['2024-11', 'java_offline', 17],
  ['2024-11', 'java_premium', 16],
  ['2024-12', 'bedrock', 10],
  ['2024-12', 'java_offline', 17],
  ['2024-12', 'java_premium', 14],
  ['2025-01', 'bedrock', 14],
  ['2025-01', 'java_offline', 11],
  ['2025-01', 'java_premium', 12],
  ['2025-02', 'bedrock', 25],
  ['2025-02', 'java_offline', 13],
  ['2025-02', 'java_premium', 16],
  ['2025-03', 'bedrock', 20],
  ['2025-03', 'java_offline', 33],
  ['2025-03', 'java_premium', 13],
  ['2025-04', 'bedrock', 22],
  ['2025-04', 'java_offline', 12],
  ['2025-04', 'java_premium', 12],
  ['2025-05', 'bedrock', 19],
  ['2025-05', 'java_offline', 24],
  ['2025-05', 'java_premium', 23],
  ['2025-06', 'bedrock', 29],
  ['2025-06', 'java_offline', 39],
  ['2025-06', 'java_premium', 26],
  ['2025-07', 'bedrock', 43],
  ['2025-07', 'java_offline', 22],
  ['2025-07', 'java_premium', 37],
  ['2025-08', 'bedrock', 32],
  ['2025-08', 'java_offline', 30],
  ['2025-08', 'java_premium', 30],
];

function options(): CohortOptions {
  return {
    evaluatedAt: NOW,
    dataThrough: NOW,
    stampDays: [],
    minimumCohortSize: 30,
    contaminationMax: 0.5,
  };
}

/**
 * Every cohort survives at 100% on every horizon — which is what the payload
 * actually says — except `2025-08 / java_offline`, whose D30 is 96,7%.
 */
function payload(): RetentionPlayer[] {
  const players: RetentionPlayer[] = [];
  let seed = 0;

  for (const [month, platform, size] of PRODUCTION) {
    const odd = month === '2025-08' && platform === 'java_offline';
    for (let i = 0; i < size; i++) {
      seed += 1;
      const short = odd && i === size - 1;
      players.push({
        uuid: UUID[platform](seed),
        registeredAt: Date.parse(`${month}-01T12:00:00-03:00`),
        lastSeenAt: short
          ? Date.parse(`${month}-11T12:00:00-03:00`)
          : Date.parse('2026-08-20T12:00:00-03:00'),
      });
    }
  }

  return players;
}

describe('the 2026-09-02 production read', () => {
  it('produces exactly one run, covering the whole window', () => {
    const all = buildCohorts(payload(), options());
    const { cohorts, spans } = applyContaminatedSpans(
      all,
      detectContaminatedSpans(all),
    );

    expect(all).toHaveLength(45);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      from: '2024-06',
      to: '2025-08',
      confirmedCohorts: 21,
      judgedCohorts: 22,
      inheritedCohorts: 23,
      inheritedPlayers: 327,
    });

    const published = cohorts.filter((c) =>
      c.measures.every((m) => m.percent !== null),
    );
    expect(published.map((c) => [c.cohort, c.platform, c.size])).toEqual([
      ['2025-08', 'java_offline', 30],
    ]);
  });
});
