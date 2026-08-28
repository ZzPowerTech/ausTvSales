import { parse as parseYaml } from 'yaml';

/**
 * Reader for one `Quests/playerdata/<uuid>.yml` file (story S8.0, ADR-0004).
 *
 * ## Why this file exists at all
 *
 * Plan collects **nothing** about the tutorial. The seventh check of spec §6.1 —
 * the one that would have caught the longest outage this server ever had, eight
 * months of the tutorial not capturing newcomers — has no source anywhere in an
 * API or a database. ADR-0004 chose the real source: the Quests plugin's own
 * per-player progress files.
 *
 * ## The shape below was observed, not imagined
 *
 * Taken from the largest real `playerdata` captured in the 2026-08-19 baseline
 * (`ops/baseline/2026-08-19/austv-diagnostico-saida.txt`), not from plugin
 * documentation:
 *
 * ```yaml
 * quest-progress:
 *   01tutorial:
 *     started: false
 *     started-date: 1723333480856
 *     completed: true
 *     completed-before: true
 *     completion-date: 1723333480856
 *     task-progress:
 *       objetivo:
 *         completed: false
 * ```
 *
 * Writing this parser from an imagined shape is the mistake that got story S6.2
 * written, merged and reverted. The fixtures in the spec file are this payload.
 *
 * ## `started` is not the "did they enter" signal — `started-date` is
 *
 * The trap in the payload above: `started: false` sits next to `completed: true`
 * on a quest the player demonstrably finished. The flag tracks *currently in
 * progress*, so it flips back off on completion. A parser that read `started`
 * would report that almost nobody ever entered the tutorial — a catastrophic
 * false negative on the exact metric this feature exists to produce.
 *
 * Entry is therefore **the presence of the quest key**, and `started-date` dates
 * it. That matches the baseline script, whose counts this parser has to
 * reproduce.
 */

/** Progress on one quest, as far as this file records it. */
export interface QuestProgress {
  /** Key under `quest-progress`, e.g. `01tutorial`. */
  questId: string;
  /**
   * `started-date` in epoch ms, or null when absent or unusable.
   *
   * Null is **not** "did not start": the key existing is what means started.
   * Null means the file did not date it, and a consumer building a daily series
   * has to drop the row rather than guess a day for it.
   */
  startedAt: number | null;
  /** `completed: true`. */
  completed: boolean;
  /** `completion-date` in epoch ms, or null. Meaningless unless `completed`. */
  completedAt: number | null;
}

/** Everything one playerdata file says, narrowed to what the ETL consumes. */
export interface PlayerdataProgress {
  /** Quests present under `quest-progress`, in file order. */
  quests: QuestProgress[];
}

/**
 * A file that could not be understood.
 *
 * Its own outcome rather than an empty result, because the two mean opposite
 * things: a player who touched no quest is a real measurement, and a file that
 * failed to parse is an absent one. Collapsing them would let a Quests upgrade
 * that changes the format read as "nobody enters the tutorial any more" — which
 * is indistinguishable from the disaster the check is looking for.
 */
export interface PlayerdataParseFailure {
  ok: false;
  reason: string;
}

export interface PlayerdataParseSuccess {
  ok: true;
  value: PlayerdataProgress;
}

export type PlayerdataParseResult =
  PlayerdataParseSuccess | PlayerdataParseFailure;

/** Top-level key holding the per-quest map. */
const QUEST_PROGRESS_KEY = 'quest-progress';

/**
 * Parse the contents of one playerdata file.
 *
 * An **empty file is a success with zero quests**, not a failure. 41% of the
 * files in the baseline were 0 bytes — players who connected and never touched a
 * quest — and treating that as an error would turn the single largest legitimate
 * category into noise.
 *
 * @param contents raw file text.
 */
export function parsePlayerdata(contents: string): PlayerdataParseResult {
  if (contents.trim().length === 0) {
    return { ok: true, value: { quests: [] } };
  }

  let document: unknown;
  try {
    // The `yaml` package resolves no custom tags and caps alias expansion, so a
    // malformed or hostile file costs a rejected parse rather than execution or
    // a memory blow-up. These files come off the game machine, which is not a
    // hostile source, but it is not this process either.
    document = parseYaml(contents);
  } catch (error) {
    return {
      ok: false,
      reason: `YAML invalido: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (document === null || document === undefined) {
    // A file of only comments or `---`. Parses fine, holds nothing.
    return { ok: true, value: { quests: [] } };
  }

  if (!isRecord(document)) {
    return { ok: false, reason: 'raiz do arquivo nao e um mapa' };
  }

  const rawProgress = document[QUEST_PROGRESS_KEY];
  if (rawProgress === undefined || rawProgress === null) {
    // The player has a file but no quest progress in it. A real zero.
    return { ok: true, value: { quests: [] } };
  }

  if (!isRecord(rawProgress)) {
    // Present but not a map: the format changed under us. Loud, not silent.
    return {
      ok: false,
      reason: `\`${QUEST_PROGRESS_KEY}\` existe mas nao e um mapa`,
    };
  }

  const quests: QuestProgress[] = [];
  for (const [questId, rawQuest] of Object.entries(rawProgress)) {
    if (!isRecord(rawQuest)) {
      // One malformed quest does not discard the other forty. Skipped rather
      // than failed, because the file still answers the question for the rest.
      continue;
    }

    quests.push({
      questId,
      startedAt: toEpochMs(rawQuest['started-date']),
      completed: rawQuest.completed === true,
      completedAt: toEpochMs(rawQuest['completion-date']),
    });
  }

  return { ok: true, value: { quests } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a Quests timestamp to epoch ms.
 *
 * Accepts the string spelling as well as the number: YAML quotes a long integer
 * in some writer configurations, and a parser that trusted only one spelling
 * would start returning nulls after a plugin update — which reads downstream as
 * "nobody entered", the failure mode this whole feature exists to avoid.
 *
 * Rejects zero and negatives. `0` is a finite number that would render as
 * 1970-01-01 and silently create a phantom cohort at the start of every series.
 */
function toEpochMs(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
