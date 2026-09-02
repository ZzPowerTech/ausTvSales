import { platformOf, type Platform } from '../instrumentation/platform';
import type { TutorialCatalogue } from './tutorial-catalogue';
import { toSaoPauloDay } from './tutorial-day';
import type { PlayerdataProgress } from './tutorial-playerdata';

/**
 * How far one player got in the tutorial (story S9.3, spec §6.4 E2).
 *
 * ## Why this is a separate function from `readContribution`
 *
 * Not tidiness. `readContribution` deliberately takes a uuid, derives the
 * platform from it, and **throws the uuid away** — that is the S8.0 rule that
 * keeps player identity out of this database for a question answered by
 * counting. This function keeps the uuid, because the question it serves is a
 * join and cannot be answered without it.
 *
 * Two paths, two footprints, and the widening one is the one you have to opt
 * into. Folding this into `readContribution` would have made the privacy
 * decision invisible at the call site, which is exactly where it should be
 * visible.
 */
export interface TutorialPosition {
  uuid: string;
  platform: Platform;
  /** Tutorial quests the player has any progress on. Always at least 1. */
  questsTouched: number;
  /** Of those, how many are marked completed. */
  questsCompleted: number;
  /** Furthest tutorial quest reached, by the catalogue's step order. */
  furthestQuestId: string | null;
  /** Its position in that order. Null when no quest could be placed. */
  furthestIndex: number | null;
  /** Whether the configured final quest is completed. */
  completedTutorial: boolean;
  /** Day the player first touched any tutorial quest, `YYYY-MM-DD`. */
  enteredOn: string | null;
}

/**
 * Read one player's tutorial position, or `null` when they never touched it.
 *
 * ## "Furthest" is by step order, and includes quests merely started
 *
 * A player stuck on step 3 has *started* step 3 and completed steps 1 and 2, and
 * the question the spec asks — *"quem trava no passo 03 gasta alguma coisa?"* —
 * is about where they stopped, not about the last thing they finished. So the
 * furthest quest is the highest-ordered one with **any** progress.
 *
 * `questsCompleted` is reported beside it precisely because the two answer
 * different questions, and a single number would have to pick one.
 *
 * @returns `null` for a player with no tutorial progress at all. They are absent
 *   from the table rather than present with zeros: a row exists to say where
 *   somebody got to, and "nowhere" is the absence of a row, not a position.
 */
export function readPosition(
  uuid: string,
  progress: PlayerdataProgress,
  catalogue: TutorialCatalogue,
): TutorialPosition | null {
  let questsTouched = 0;
  let questsCompleted = 0;
  let furthestIndex: number | null = null;
  let furthestQuestId: string | null = null;
  let earliestStart: number | null = null;
  let completedTutorial = false;

  for (const quest of progress.quests) {
    const order = catalogue.orderOf(quest.questId);
    if (order === null) {
      // Daily quests, seasonal events and everything else in the same file.
      continue;
    }

    questsTouched += 1;
    if (quest.completed) {
      questsCompleted += 1;
    }
    if (quest.questId === catalogue.finalQuestId && quest.completed) {
      completedTutorial = true;
    }

    if (furthestIndex === null || order > furthestIndex) {
      furthestIndex = order;
      furthestQuestId = quest.questId;
    }

    if (
      quest.startedAt !== null &&
      (earliestStart === null || quest.startedAt < earliestStart)
    ) {
      earliestStart = quest.startedAt;
    }
  }

  if (questsTouched === 0) {
    return null;
  }

  return {
    uuid,
    platform: platformOf(uuid),
    questsTouched,
    questsCompleted,
    furthestQuestId,
    furthestIndex,
    completedTutorial,
    enteredOn: toSaoPauloDay(earliestStart),
  };
}
