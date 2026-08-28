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
 * Unconfigured path, unreadable directory, empty catalogue, **and any scan whose
 * result is too degenerate to be believed**: all of them record an `error` sync
 * and write **nothing**. The series from the last successful run stays in place,
 * dated by its own sync record.
 *
 * The alternative — clearing the table on failure — would turn a typo in an
 * environment variable into "nobody has ever entered the tutorial", which is
 * exactly the shape of the disaster the seventh check exists to detect. A
 * monitoring system that can fabricate its own alarm is worse than none.
 *
 * "Too degenerate" is four specific rules, not a vibe, and two of them measure
 * the scan's **output** rather than its input — because the accidents that keep
 * `filesScanned` high (a Quests format change, a renamed quest id) are exactly
 * the ones an input-only floor waves through. See
 * {@link TutorialSyncService.floorRefusal}.
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
   * Decide whether a scan is too degenerate to be believed, before it overwrites.
   *
   * ## The hole this closes
   *
   * `replaceAll` deletes the whole series and rewrites it. That is correct for a
   * snapshot source — but it means **any** path that reaches it with nothing to
   * write erases everything and stamps the run `ok`. A later reader consults
   * `tutorial_syncs`, sees a successful run covering the period, and renders the
   * hole as a legitimate zero: "nobody entered the tutorial", which is
   * indistinguishable from the eight-month outage the seventh check exists to
   * catch. The layer would fabricate its own alarm, or bury a real one.
   *
   * Three separate accidents lead there, and the first version of this guard
   * only caught the first:
   *
   * | accident | what it looks like | caught by |
   * |---|---|---|
   * | `rsync` has not run; empty mount | 0 files | rule 1 |
   * | `rsync` caught mid-flight | few files | rule 2 |
   * | **Quests changed its file format** | many files, all unparseable | **rule 3** |
   * | **A tutorial quest was renamed** | many files, zero tutorial players | **rule 4** |
   *
   * Rules 3 and 4 are the ones that measure the scan's **output** rather than
   * its input, and they matter because `filesScanned` stays high in both. The
   * ceiling guard (`MAX_FILES`) had no counterpart on the floor, and the floor
   * is the direction that erases data.
   *
   * ## Why rule 4 needs the previous run
   *
   * "Zero tutorial players" is legitimate on a brand-new server and catastrophic
   * on this one. Only the previous successful run distinguishes them, which is
   * why `players_in_tutorial` is persisted rather than merely logged.
   */
  private async floorRefusal(scan: ScanSummary): Promise<string | null> {
    if (scan.filesScanned === 0) {
      return (
        'Nenhum arquivo de playerdata encontrado — o diretorio existe mas esta ' +
        'vazio (rsync que ainda nao rodou, montagem vazia, ou caminho errado ' +
        'que por acaso existe). Nada foi escrito: sobrescrever a serie com zero ' +
        'seria indistinguivel do apagao que o check procura.'
      );
    }

    const failureRate = scan.filesFailed / scan.filesScanned;
    if (failureRate >= MAX_PARSE_FAILURE_RATE) {
      const percent = Math.round(failureRate * 100);
      return (
        `${scan.filesFailed} de ${scan.filesScanned} arquivos ilegiveis (${percent}%) — ` +
        'isto e o que uma mudanca de formato do plugin Quests parece, nao uma ' +
        'queda de jogadores. Nada foi escrito; a serie anterior continua de pe.'
      );
    }

    let last: Awaited<ReturnType<TutorialStore['lastSuccessfulSync']>>;
    try {
      last = await this.store.lastSuccessfulSync();
    } catch (error) {
      // The relative floors are a safety net, not a gate. The two absolute rules
      // above have already done the important half, and refusing the whole run
      // because the provenance table is unreadable trades one failure for
      // another.
      this.logger.warn(
        `Nao foi possivel ler o ultimo sync bem-sucedido para conferir o piso: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    if (last === null) {
      // First ever run: nothing to compare against, and refusing it would mean
      // the series could never be populated in the first place.
      return null;
    }

    const previousFiles = last.filesScanned ?? 0;
    if (previousFiles > 0) {
      const floor = Math.floor(previousFiles * MIN_SCAN_FRACTION_OF_LAST);
      if (scan.filesScanned < floor) {
        return (
          `Apenas ${scan.filesScanned} arquivos lidos contra ${previousFiles} do ` +
          `ultimo sync bem-sucedido (piso ${floor}) — queda dessa ordem e problema ` +
          'de fonte, nao de jogadores: o corpus so cresce, porque o playerdata ' +
          'sobrevive ao jogador sair. Nada foi escrito; a serie anterior continua ' +
          'de pe.'
        );
      }
    }

    const previousPlayers = last.playersInTutorial ?? 0;
    if (previousPlayers > 0 && scan.playersInTutorial === 0) {
      return (
        `Nenhum jogador no tutorial entre ${scan.filesScanned} arquivos legiveis, ` +
        `contra ${previousPlayers} no ultimo sync bem-sucedido — isto e o que um id ` +
        'de quest renomeado parece (o catalogo carregou, mas nenhuma chave casa). ' +
        'Nada foi escrito; a serie anterior continua de pe.'
      );
    }

    return null;
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

    const refusal = await this.floorRefusal({
      filesScanned,
      filesFailed,
      playersInTutorial,
    });
    if (refusal !== null) {
      this.logger.error(refusal);
      await this.store.recordFailure({
        detail: refusal,
        filesScanned,
        filesFailed,
        playersInTutorial,
        // What the run *would* have written, recorded on the refusal so the
        // provenance row says how close it came rather than only that it stopped.
        daysWritten: rows.length,
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

    await this.store.replaceAll(rows, {
      filesScanned,
      filesFailed,
      playersInTutorial,
      daysWritten: rows.length,
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

/**
 * Share of unparseable files above which the whole run is refused.
 *
 * Individual failures are normal and are counted, not fatal — one corrupt file
 * among twenty thousand says nothing. Half of them failing says the format
 * changed, which is a Quests upgrade, and writing the survivors' numbers as if
 * they were the whole corpus is how a plugin update becomes a reported collapse.
 */
const MAX_PARSE_FAILURE_RATE = 0.5;

/** What the walk produced, as the floor rules see it. */
interface ScanSummary {
  filesScanned: number;
  filesFailed: number;
  playersInTutorial: number;
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
