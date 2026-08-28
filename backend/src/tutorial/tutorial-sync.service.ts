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
 * Unconfigured path, unreadable directory, empty catalogue, **and a scan that
 * came back implausibly small**: all of them record an `error` sync and write
 * **nothing**. The series from the last successful run stays in place, dated by
 * its own sync record.
 *
 * The alternative — clearing the table on failure — would turn a typo in an
 * environment variable into "nobody has ever entered the tutorial", which is
 * exactly the shape of the disaster the seventh check exists to detect. A
 * monitoring system that can fabricate its own alarm is worse than none.
 *
 * The "implausibly small" clause is not defensive padding: an **empty but
 * existing** directory does not make `opendir` throw, so without it the most
 * likely deployment accident — an `rsync` that has not run yet — was a silent
 * wipe recorded as success. See {@link TutorialSyncService.floorRefusal}.
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
  /**
   * Guards against a second run starting while one is still walking the disk.
   *
   * **Per instance, so it is not a distributed lock.** With more than one
   * replica, two processes can walk and write concurrently, and the
   * replace-all transactions would race. Sound today — the API runs as a single
   * container — and the thing to fix first if it ever scales out. An advisory
   * lock in Postgres is the cheap answer when that day comes.
   */
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

  /**
   * Decide whether a scan is too small to be believed, before it overwrites.
   *
   * ## The hole this closes, which the first version of this class had
   *
   * `opendir` on an **empty but existing** directory does not throw. So a
   * playerdata path that resolved to an empty mount — an `rsync` that had not
   * run yet, a volume that came up bare, a wrong path that happened to exist —
   * walked zero files, aggregated zero rows, and reached `replaceAll([])`, which
   * deleted the entire series and recorded the run as **`ok`**.
   *
   * That is worse than a crash in the exact way this epic cares about. A later
   * reader consults `tutorial_syncs`, sees a successful run covering the period,
   * and renders the hole as a legitimate zero — "nobody entered the tutorial" —
   * which is indistinguishable from the eight-month outage the seventh check
   * exists to catch. The layer would have fabricated its own alarm, or hidden a
   * real one.
   *
   * The class doc claimed "every failure leaves the previous numbers standing";
   * it was true for an absent directory and false for an empty one.
   *
   * ## Two floors
   *
   * 1. **Zero files is never a valid scan.** The corpus had 19.700 files in the
   *    baseline and only grows — a `playerdata` outlives the player leaving.
   * 2. **A scan under half the previous successful one is refused.** Catches the
   *    partial copy, which is the failure mode a truncated scan produces: a
   *    smaller number written as `ok`, reading exactly like a drop in entries.
   *
   * The symmetry with `MAX_FILES` is the point — there was a ceiling guard and
   * no floor guard, and the floor is the direction that erases data.
   */
  private async floorRefusal(filesScanned: number): Promise<string | null> {
    if (filesScanned === 0) {
      return (
        'Nenhum arquivo de playerdata encontrado — o diretorio existe mas esta ' +
        'vazio (rsync que ainda nao rodou, montagem vazia, ou caminho errado ' +
        'que por acaso existe). Nada foi escrito: sobrescrever a serie com zero ' +
        'seria indistinguivel do apagao que o check procura.'
      );
    }

    let last: Awaited<ReturnType<TutorialStore['lastSuccessfulSync']>>;
    try {
      last = await this.store.lastSuccessfulSync();
    } catch (error) {
      // The floor is a safety net, not a gate. If the provenance table cannot be
      // read, the absolute floor above has already done the important half, and
      // refusing the whole run over it would trade one failure for another.
      this.logger.warn(
        `Nao foi possivel ler o ultimo sync bem-sucedido para conferir o piso: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    const previous = last?.filesScanned ?? null;
    if (previous === null || previous === 0) {
      // First ever run, or no prior count to compare against.
      return null;
    }

    const floor = Math.floor(previous * MIN_SCAN_FRACTION_OF_LAST);
    if (filesScanned >= floor) {
      return null;
    }

    return (
      `Apenas ${filesScanned} arquivos lidos contra ${previous} do ultimo sync ` +
      `bem-sucedido (piso ${floor}) — queda dessa ordem e problema de fonte, nao ` +
      'de jogadores: o corpus so cresce, porque o playerdata sobrevive ao jogador ' +
      'sair. Nada foi escrito; a serie anterior continua de pe.'
    );
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

    const refusal = await this.floorRefusal(filesScanned);
    if (refusal !== null) {
      this.logger.error(refusal);
      await this.store.recordFailure({
        detail: refusal,
        filesScanned,
        filesFailed,
        questsInCatalogue: catalogue.ids.length,
        finalQuestId: catalogue.finalQuestId,
      });
      return {
        ...emptyFailure(refusal),
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

/**
 * Fraction of the previous run's file count below which a scan is refused.
 *
 * A directory that shrank by more than half between two nightly runs is a
 * source problem, not a player exodus: the corpus only grows, because a
 * `playerdata` file survives the player leaving. The default is deliberately
 * loose — this is a guard against a broken mount, not a statistical test.
 */
const MIN_SCAN_FRACTION_OF_LAST = 0.5;

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
