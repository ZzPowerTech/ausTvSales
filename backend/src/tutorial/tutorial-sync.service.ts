import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  aggregate,
  readContribution,
  uuidFromFileName,
  type PlayerContribution,
} from './tutorial-aggregate';
import { loadTutorialCatalogue } from './tutorial-catalogue';
import { parsePlayerdata } from './tutorial-playerdata';
import { TutorialStore } from './tutorial.store';

/** Default final quest, from the 2026-08-19 baseline. Overridable. */
const DEFAULT_FINAL_QUEST_ID = '33tutorial';

/**
 * Ceiling on files read in one run.
 *
 * Not a performance tuning knob — a runaway guard. The baseline directory held
 * 19.700 files; a path pointed at the wrong place (a home directory, a mount
 * root) could hold millions, and the job would read them all before anyone
 * noticed. Hitting the cap **fails the run** rather than truncating it, because
 * a truncated scan produces a number that looks like a collapse in entries.
 */
const MAX_FILES = 250_000;

/** Outcome of one sync, returned so a caller (or a test) can assert on it. */
export interface TutorialSyncResult {
  status: 'ok' | 'error';
  filesScanned: number;
  filesFailed: number;
  /** Players who touched the tutorial, dated or not. */
  playersInTutorial: number;
  /** Players in the tutorial whose entry had no usable date. */
  playersUndated: number;
  daysWritten: number;
  detail?: string;
}

/**
 * Nightly rebuild of the tutorial funnel from `Quests/playerdata` (story S8.0).
 *
 * ADR-0004 chose this source because Plan collects nothing about the tutorial
 * and the data exists nowhere else. What the ADR does **not** decide, and this
 * class therefore cannot assume, is *how* the directory becomes readable from
 * the sales VPS — `rsync`, a read-only mount, or a collector on the game
 * machine. This class takes a path and reads it.
 *
 * ## Every failure leaves the previous numbers standing
 *
 * Unconfigured path, unreadable directory, empty catalogue: all of them record
 * an `error` sync and write **nothing**. The series from the last successful run
 * stays in place, dated by its own sync record.
 *
 * The alternative — clearing the table on failure — would turn a typo in an
 * environment variable into "nobody has ever entered the tutorial", which is
 * exactly the shape of the disaster the seventh check exists to detect. A
 * monitoring system that can fabricate its own alarm is worse than none.
 *
 * ## Never on the request path
 *
 * ~20.000 file reads and YAML parses. It is invoked by a schedule, or by hand,
 * and no HTTP route triggers it.
 */
@Injectable()
export class TutorialSyncService implements OnModuleInit {
  private readonly logger = new Logger(TutorialSyncService.name);

  private readonly playerdataDir: string | null;
  private readonly catalogueDir: string | null;
  private readonly finalQuestId: string;
  /** Guards against a second run starting while one is still walking the disk. */
  private running = false;

  constructor(
    private readonly store: TutorialStore,
    config: ConfigService,
  ) {
    this.playerdataDir =
      config.get<string>('TUTORIAL_PLAYERDATA_DIR')?.trim() || null;
    this.catalogueDir =
      config.get<string>('TUTORIAL_QUESTS_DIR')?.trim() || null;
    this.finalQuestId =
      config.get<string>('TUTORIAL_FINAL_QUEST_ID')?.trim() ||
      DEFAULT_FINAL_QUEST_ID;
  }

  onModuleInit(): void {
    if (!this.configured) {
      // Loud, and for the same reason the Plan client is loud: the seventh check
      // reads this table, and a check with no source must report that rather
      // than report a healthy zero.
      this.logger.warn(
        'TUTORIAL_PLAYERDATA_DIR/TUTORIAL_QUESTS_DIR nao configurados — o funil ' +
          'do tutorial fica sem fonte e o check funnel.tutorial_entry_rate vai ' +
          'reportar `no_data`, nunca `ok`.',
      );
      return;
    }

    this.logger.log(
      `Fonte do tutorial: ${this.playerdataDir} (quest final ${this.finalQuestId})`,
    );
  }

  /** False when either directory is unset — callers report "sem dados". */
  get configured(): boolean {
    return Boolean(this.playerdataDir && this.catalogueDir);
  }

  /**
   * Rebuild the whole series from the current contents of the directory.
   *
   * Idempotent: the source is a snapshot, so running it twice in a row produces
   * identical rows. Re-running is the normal operation, not a recovery path.
   */
  async sync(): Promise<TutorialSyncResult> {
    if (this.running) {
      // Two concurrent walks would double the disk cost and race on the
      // replace-all transaction. The schedule and a manual trigger can overlap.
      const detail = 'Uma sincronizacao do tutorial ja esta em andamento';
      this.logger.warn(detail);
      return emptyFailure(detail);
    }

    if (!this.playerdataDir || !this.catalogueDir) {
      const detail =
        'TUTORIAL_PLAYERDATA_DIR/TUTORIAL_QUESTS_DIR nao configurados — ' +
        'sem fonte para o funil do tutorial';
      await this.store.recordFailure({ detail });
      return emptyFailure(detail);
    }

    this.running = true;
    try {
      return await this.run(this.playerdataDir, this.catalogueDir);
    } finally {
      this.running = false;
    }
  }

  private async run(
    playerdataDir: string,
    catalogueDir: string,
  ): Promise<TutorialSyncResult> {
    const started = Date.now();

    let catalogue;
    try {
      catalogue = await loadTutorialCatalogue(catalogueDir, this.finalQuestId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(detail);
      await this.store.recordFailure({
        detail,
        finalQuestId: this.finalQuestId,
      });
      return emptyFailure(detail);
    }

    const contributions: PlayerContribution[] = [];
    let filesScanned = 0;
    let filesFailed = 0;
    let playersInTutorial = 0;
    let playersUndated = 0;

    try {
      // `opendir` streams the entries instead of materialising 20.000 names,
      // and lets the cap abort before the whole listing is in memory.
      const dir = await opendir(playerdataDir);
      for await (const entry of dir) {
        if (!entry.isFile()) {
          continue;
        }

        const uuid = uuidFromFileName(entry.name);
        if (uuid === null) {
          // Not a playerdata file. Skipped silently rather than counted as a
          // parse failure — a README in the directory is not a data problem.
          continue;
        }

        if (filesScanned >= MAX_FILES) {
          throw new Error(
            `Mais de ${MAX_FILES} arquivos em "${playerdataDir}" — o caminho ` +
              'provavelmente aponta para o lugar errado. Abortado sem escrever, ' +
              'porque uma varredura truncada pareceria uma queda nas entradas.',
          );
        }
        filesScanned += 1;

        let contents: string;
        try {
          contents = await readFile(join(playerdataDir, entry.name), 'utf8');
        } catch {
          filesFailed += 1;
          continue;
        }

        const parsed = parsePlayerdata(contents);
        if (!parsed.ok) {
          filesFailed += 1;
          continue;
        }

        const contribution = readContribution(uuid, parsed.value, catalogue);
        if (!contribution.touchedTutorial) {
          continue;
        }

        playersInTutorial += 1;
        if (contribution.enteredOn === null) {
          playersUndated += 1;
        }
        contributions.push(contribution);
      }
    } catch (error) {
      const detail = `Falha ao ler "${playerdataDir}": ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.logger.error(detail);
      await this.store.recordFailure({
        detail,
        filesScanned,
        filesFailed,
        questsInCatalogue: catalogue.ids.length,
        finalQuestId: catalogue.finalQuestId,
      });
      return {
        ...emptyFailure(detail),
        filesScanned,
        filesFailed,
        playersInTutorial,
        playersUndated,
      };
    }

    const rows = aggregate(contributions);
    await this.store.replaceAll(rows, {
      filesScanned,
      filesFailed,
      questsInCatalogue: catalogue.ids.length,
      finalQuestId: catalogue.finalQuestId,
    });

    const elapsed = Date.now() - started;
    // `filesFailed` is logged next to `filesScanned` and never folded into it:
    // a run that read 19.700 files and failed on 9.000 produced a number, and
    // whoever reads that number has to know it covers half the corpus.
    this.logger.log(
      `Funil do tutorial reconstruido em ${elapsed}ms: ${filesScanned} arquivos ` +
        `(${filesFailed} ilegiveis), ${playersInTutorial} jogadores no tutorial ` +
        `(${playersUndated} sem data), ${rows.length} linhas dia x plataforma`,
    );

    return {
      status: 'ok',
      filesScanned,
      filesFailed,
      playersInTutorial,
      playersUndated,
      daysWritten: rows.length,
    };
  }
}

function emptyFailure(detail: string): TutorialSyncResult {
  return {
    status: 'error',
    filesScanned: 0,
    filesFailed: 0,
    playersInTutorial: 0,
    playersUndated: 0,
    daysWritten: 0,
    detail,
  };
}
