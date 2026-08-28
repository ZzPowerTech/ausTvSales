import { ConfigService } from '@nestjs/config';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TutorialDayRow } from './tutorial-aggregate';
import { TutorialSyncService } from './tutorial-sync.service';
import type {
  FailedSync,
  SuccessfulSync,
  TutorialStore,
} from './tutorial.store';

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

/** Records what the service asked the store to do, without a database. */
class StoreSpy {
  replaced: { rows: readonly TutorialDayRow[]; sync: SuccessfulSync }[] = [];
  failures: FailedSync[] = [];

  replaceAll(
    rows: readonly TutorialDayRow[],
    sync: SuccessfulSync,
  ): Promise<void> {
    this.replaced.push({ rows, sync });
    return Promise.resolve();
  }

  recordFailure(failure: FailedSync): Promise<void> {
    this.failures.push(failure);
    return Promise.resolve();
  }

  /** What `lastSuccessfulSync` answers. Null = no run ever succeeded. */
  previousSync: { filesScanned: number | null } | null = null;
  /** Set to make the provenance read fail, exercising the degraded path. */
  lastSyncThrows = false;

  lastSuccessfulSync(): Promise<unknown> {
    if (this.lastSyncThrows) {
      return Promise.reject(new Error('banco fora do ar'));
    }
    return Promise.resolve(this.previousSync);
  }

  asStore(): TutorialStore {
    return this as unknown as TutorialStore;
  }
}

/** 2026-03-10 12:00 BRT. */
const MARCH_10 = Date.UTC(2026, 2, 10, 15, 0, 0);

function playerdata(
  quests: Record<string, { started?: number; done?: number }>,
) {
  const body = Object.entries(quests)
    .map(([id, q]) => {
      const lines = [`  ${id}:`];
      if (q.started !== undefined) lines.push(`    started-date: ${q.started}`);
      if (q.done !== undefined) {
        lines.push('    completed: true', `    completion-date: ${q.done}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  return `quest-progress:\n${body}\n`;
}

interface Fixture {
  playerdataDir: string;
  catalogueDir: string;
  store: StoreSpy;
  service: TutorialSyncService;
}

async function withFixture(
  setup: {
    quests?: string[];
    players?: Record<string, string>;
    finalQuestId?: string;
    /** Omit a directory from the config to test the unconfigured path. */
    unconfigured?: boolean;
  },
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'austv-sync-'));
  const playerdataDir = join(root, 'playerdata');
  const catalogueDir = join(root, 'tutorial');

  try {
    await mkdir(playerdataDir, { recursive: true });
    await mkdir(catalogueDir, { recursive: true });

    for (const quest of setup.quests ?? ['01tutorial', '33tutorial']) {
      await writeFile(
        join(catalogueDir, `${quest}.yml`),
        'tasks: {}\n',
        'utf8',
      );
    }
    for (const [name, contents] of Object.entries(setup.players ?? {})) {
      await writeFile(join(playerdataDir, name), contents, 'utf8');
    }

    const store = new StoreSpy();
    const service = new TutorialSyncService(
      store.asStore(),
      configWith(
        setup.unconfigured
          ? {}
          : {
              TUTORIAL_PLAYERDATA_DIR: playerdataDir,
              TUTORIAL_QUESTS_DIR: catalogueDir,
              TUTORIAL_FINAL_QUEST_ID: setup.finalQuestId ?? '33tutorial',
            },
      ),
    );

    await run({ playerdataDir, catalogueDir, store, service });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const BEDROCK = '00000000-0000-0000-0009-0000000abcde';
const PREMIUM = '11111111-2222-4333-8444-555555555555';

describe('TutorialSyncService', () => {
  describe('a successful run', () => {
    it('builds the daily series from the directory', async () => {
      await withFixture(
        {
          players: {
            [`${BEDROCK}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
              '33tutorial': { started: MARCH_10, done: MARCH_10 },
            }),
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          const result = await service.sync();

          expect(result.status).toBe('ok');
          expect(result.filesScanned).toBe(2);
          expect(result.playersInTutorial).toBe(2);
          expect(store.replaced).toHaveLength(1);
          expect(store.replaced[0].rows).toEqual([
            {
              day: '2026-03-10',
              platform: 'bedrock',
              entered: 1,
              completed: 1,
            },
            {
              day: '2026-03-10',
              platform: 'java_premium',
              entered: 1,
              completed: 0,
            },
          ]);
        },
      );
    });

    it('is idempotent: a second run writes the same rows', async () => {
      // The source is a snapshot of current state, so re-running is the normal
      // operation rather than a recovery path (criterion 2 of S8.0).
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          await service.sync();
          await service.sync();

          expect(store.replaced).toHaveLength(2);
          expect(store.replaced[0].rows).toEqual(store.replaced[1].rows);
        },
      );
    });

    it('records which quest was counted as completion', async () => {
      // The completion count is meaningless without it, and the id is expected
      // to change when the tutorial does (ADR-0004).
      await withFixture(
        {
          quests: ['01tutorial', '40tutorial'],
          finalQuestId: '40tutorial',
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          await service.sync();

          expect(store.replaced[0].sync).toMatchObject({
            finalQuestId: '40tutorial',
            questsInCatalogue: 2,
          });
        },
      );
    });

    it('skips files that are not playerdata without counting them as failures', async () => {
      await withFixture(
        {
          players: {
            'README.md': 'nao sou playerdata\n',
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          const result = await service.sync();

          expect(result.filesScanned).toBe(1);
          expect(result.filesFailed).toBe(0);
          expect(store.replaced[0].sync.filesFailed).toBe(0);
        },
      );
    });

    it('counts an unreadable playerdata as failed and keeps going', async () => {
      await withFixture(
        {
          players: {
            [`${BEDROCK}.yml`]: 'quest-progress:\n  a: [1,\n',
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          const result = await service.sync();

          expect(result.status).toBe('ok');
          expect(result.filesScanned).toBe(2);
          // Reported separately from `filesScanned`, never folded into it: a run
          // that failed on half the corpus still produced a number, and whoever
          // reads that number has to know its coverage.
          expect(result.filesFailed).toBe(1);
          expect(store.replaced[0].rows).toHaveLength(1);
        },
      );
    });

    it('counts an undated entrant without giving them a day', async () => {
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]:
              'quest-progress:\n  01tutorial:\n    completed: false\n',
          },
        },
        async ({ store, service }) => {
          const result = await service.sync();

          expect(result.playersInTutorial).toBe(1);
          expect(result.playersUndated).toBe(1);
          // No day to file them under, so no row — and the totals say so rather
          // than pretending the player never entered.
          expect(store.replaced[0].rows).toEqual([]);
        },
      );
    });

    it('ignores players who only touched non-tutorial quests', async () => {
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              diario_escavacao: { started: MARCH_10, done: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          const result = await service.sync();

          expect(result.filesScanned).toBe(1);
          expect(result.playersInTutorial).toBe(0);
          expect(store.replaced[0].rows).toEqual([]);
        },
      );
    });
  });

  describe('every failure leaves the previous numbers standing', () => {
    it('writes nothing when the directories are not configured', async () => {
      await withFixture({ unconfigured: true }, async ({ store, service }) => {
        const result = await service.sync();

        expect(result.status).toBe('error');
        expect(service.configured).toBe(false);
        // The critical assertion: no replaceAll. Clearing the table on a missing
        // env var would turn a typo into "nobody ever entered the tutorial" —
        // the exact shape of the disaster the seventh check looks for.
        expect(store.replaced).toEqual([]);
        expect(store.failures).toHaveLength(1);
        expect(store.failures[0].detail).toContain('TUTORIAL_PLAYERDATA_DIR');
      });
    });

    it('writes nothing when the catalogue directory is unreadable', async () => {
      await withFixture({ quests: [] }, async ({ store, service }) => {
        const result = await service.sync();

        expect(result.status).toBe('error');
        expect(store.replaced).toEqual([]);
        expect(store.failures[0].detail).toContain('nenhum arquivo');
      });
    });

    it('writes nothing when the final quest is not in the catalogue', async () => {
      await withFixture(
        { quests: ['01tutorial'], finalQuestId: '99tutorial' },
        async ({ store, service }) => {
          const result = await service.sync();

          expect(result.status).toBe('error');
          expect(store.replaced).toEqual([]);
          expect(store.failures[0].finalQuestId).toBe('99tutorial');
        },
      );
    });

    it('writes nothing when the directory exists but is EMPTY', async () => {
      // The hole that reproved the first version of this PR. `opendir` on an
      // empty-but-existing directory does not throw, so the scan walked zero
      // files, aggregated zero rows, and called replaceAll([]) — which deleted
      // the entire series and recorded the run as `ok`.
      //
      // Worse than a crash in the way this epic cares about: a later reader
      // consults tutorial_syncs, sees a successful run covering the period, and
      // renders the hole as a legitimate zero. That is indistinguishable from
      // the eight-month outage the seventh check exists to catch.
      //
      // Not hypothetical: the ADR recommends rsync, and an rsync that has not
      // run yet produces exactly this directory.
      await withFixture({ players: {} }, async ({ store, service }) => {
        const result = await service.sync();

        expect(result.status).toBe('error');
        expect(store.replaced).toEqual([]);
        expect(store.failures[0].detail).toContain('vazio');
      });
    });

    it('writes nothing when the scan collapsed against the last good run', async () => {
      // The partial copy — rsync caught mid-flight. A truncated scan writes a
      // smaller number as `ok`, which reads exactly like a drop in entries.
      // There was a ceiling guard (MAX_FILES) and no floor guard, and the floor
      // is the direction that erases data.
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          store.previousSync = { filesScanned: 19_700 };

          const result = await service.sync();

          expect(result.status).toBe('error');
          expect(store.replaced).toEqual([]);
          expect(store.failures[0].detail).toContain('19700');
          // The count it did read travels with the refusal, so whoever reads the
          // provenance can tell a collapsed scan from a failed one.
          expect(store.failures[0].filesScanned).toBe(1);
        },
      );
    });

    it('accepts a scan that shrank within tolerance', async () => {
      // The floor is a guard against a broken mount, not a statistical test on
      // player behaviour. A run that reads most of the previous corpus proceeds.
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
            [`${BEDROCK}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          store.previousSync = { filesScanned: 3 };

          const result = await service.sync();

          expect(result.status).toBe('ok');
          expect(store.replaced).toHaveLength(1);
        },
      );
    });

    it('still writes on the very first run, with no previous count to compare', async () => {
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          store.previousSync = null;

          const result = await service.sync();

          expect(result.status).toBe('ok');
          expect(store.replaced).toHaveLength(1);
        },
      );
    });

    it('does not fail the run when the provenance read itself fails', async () => {
      // The relative floor is a safety net, not a gate. The absolute floor has
      // already done the important half; refusing the whole run because the
      // provenance table is unreadable would trade one failure for another.
      await withFixture(
        {
          players: {
            [`${PREMIUM}.yml`]: playerdata({
              '01tutorial': { started: MARCH_10 },
            }),
          },
        },
        async ({ store, service }) => {
          store.lastSyncThrows = true;

          const result = await service.sync();

          expect(result.status).toBe('ok');
          expect(store.replaced).toHaveLength(1);
        },
      );
    });

    it('writes nothing when the playerdata directory does not exist', async () => {
      await withFixture({}, async ({ playerdataDir, store, service }) => {
        await rm(playerdataDir, { recursive: true, force: true });

        const result = await service.sync();

        expect(result.status).toBe('error');
        expect(store.replaced).toEqual([]);
        expect(store.failures[0].detail).toContain('Falha ao ler');
      });
    });
  });

  it('refuses a second concurrent run instead of walking the disk twice', async () => {
    await withFixture(
      {
        players: {
          [`${PREMIUM}.yml`]: playerdata({
            '01tutorial': { started: MARCH_10 },
          }),
        },
      },
      async ({ store, service }) => {
        const [first, second] = await Promise.all([
          service.sync(),
          service.sync(),
        ]);

        // Exactly one of the two ran; the other was refused. Which one wins is
        // a scheduling detail, so the assertion is on the pair.
        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual(['error', 'ok']);
        expect(store.replaced).toHaveLength(1);
      },
    );
  });
});
