import { readdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * Which quest ids are tutorial steps (story S8.0, ADR-0004).
 *
 * ## The catalogue is read, not hardcoded
 *
 * The ids come from the file names in `Quests/quests/tutorial/` — the same place
 * the baseline script read them (`ops/baseline/scripts/austv-diagnostico.ps1`,
 * block 2). The 2026-08-19 snapshot had **41** of them, with numeric prefixes
 * and variants: `01tutorial`, `04-2tutorial`, `12-3tutorial`, `33tutorial`.
 *
 * Hardcoding the list would freeze a business fact that has already changed:
 * the tutorial gained the `-2` and `-3` branches at some point, and a frozen
 * list would silently stop counting the players who took them.
 *
 * ## An empty catalogue is a failure, never an empty answer
 *
 * If the directory is missing or unreadable, {@link TutorialCatalogue.load}
 * throws. It must: an empty set of tutorial ids makes **every** player look like
 * someone who never entered the tutorial, which is exactly the reading the
 * seventh check exists to raise the alarm about. A misconfigured path would
 * manufacture the disaster it is supposed to detect.
 */

/** A tutorial catalogue that was successfully read from disk. */
export interface TutorialCatalogue {
  /** Every tutorial quest id, in the order the directory listed them. */
  readonly ids: readonly string[];
  /** Whether a quest id from a playerdata file is a tutorial step. */
  has(questId: string): boolean;
  /**
   * The id that marks the tutorial as finished.
   *
   * Configurable rather than derived, and the value in use travels with every
   * number computed from it. Deriving "the highest numeric prefix" would look
   * clever and break the day someone adds a `34tutorial` epilogue that is not
   * meant to be the completion gate.
   */
  readonly finalQuestId: string;
}

/** Extension of the quest definition files. */
const QUEST_FILE_EXTENSION = '.yml';

/**
 * Read the tutorial quest ids from a directory of quest definitions.
 *
 * @param directory path to `Quests/quests/tutorial`.
 * @param finalQuestId id that marks completion; must exist in the directory.
 *
 * @throws when the directory cannot be read, holds no quest file, or does not
 *   contain `finalQuestId`. Every one of those is a configuration fault that
 *   would otherwise surface as a plausible-looking zero.
 */
export async function loadTutorialCatalogue(
  directory: string,
  finalQuestId: string,
): Promise<TutorialCatalogue> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new Error(
      `Nao foi possivel ler o catalogo de quests do tutorial em "${directory}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const ids = entries
    .filter((entry) => extname(entry).toLowerCase() === QUEST_FILE_EXTENSION)
    .map((entry) => basename(entry, extname(entry)));

  if (ids.length === 0) {
    throw new Error(
      `O catalogo em "${directory}" nao tem nenhum arquivo ${QUEST_FILE_EXTENSION} — ` +
        'catalogo vazio faria todo jogador parecer nunca ter entrado no tutorial',
    );
  }

  const idSet = new Set(ids);

  if (!idSet.has(finalQuestId)) {
    // Caught here rather than downstream: without this, completion would be
    // counted against a quest nobody can hold and the funnel would publish a
    // permanent 0% completion, which is a believable number and a false one.
    throw new Error(
      `A quest final "${finalQuestId}" nao existe no catalogo de "${directory}" ` +
        `(${ids.length} quests encontradas) — confira TUTORIAL_FINAL_QUEST_ID`,
    );
  }

  return {
    ids,
    has: (questId: string) => idSet.has(questId),
    finalQuestId,
  };
}
