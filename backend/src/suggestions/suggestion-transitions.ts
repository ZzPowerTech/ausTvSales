import { SUGGESTION_STATUSES, type SuggestionStatus } from '../db/schema';

/**
 * The state machine of spec §5.3:
 *
 * ```
 * enviada → aprovada → em_andamento → concluida | recusada
 * ```
 *
 * ## `recusada` is reachable from every open state, and that is a reading
 *
 * Read as a strict chain, the diagram above puts `recusada` only after
 * `em_andamento` — a suggestion could not be turned down without first being
 * approved and started. For a suggestion box that is the wrong shape: most
 * refusals happen the moment staff reads the suggestion, and forcing an
 * approval first would put a lie in the audit trail of every rejected item.
 *
 * So the diagram is read as "the happy path, plus refusal as the way out", and
 * `recusada` is reachable from any state that is still open. This is the one
 * place this module goes beyond the literal text of the spec; it is flagged in
 * the PR rather than buried here.
 *
 * ## Both endings are terminal
 *
 * `concluida` and `recusada` accept nothing. Re-opening a decided suggestion is
 * a different feature with its own audit questions ("who re-opened it, and what
 * happened to the previous decision"), and a state machine that quietly allows
 * it answers none of them. If re-opening is wanted, it earns a transition and a
 * test — it does not arrive by the absence of a rule.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<SuggestionStatus, readonly SuggestionStatus[]>
> = Object.freeze({
  enviada: ['aprovada', 'recusada'],
  aprovada: ['em_andamento', 'recusada'],
  em_andamento: ['concluida', 'recusada'],
  concluida: [],
  recusada: [],
});

/** States that accept no further transition. */
export const TERMINAL_STATUSES: readonly SuggestionStatus[] =
  SUGGESTION_STATUSES.filter(
    (status) => ALLOWED_TRANSITIONS[status].length === 0,
  );

/** Whether `to` is a legal next state for a suggestion currently in `from`. */
export function canTransition(
  from: SuggestionStatus,
  to: SuggestionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Whether `value` is one of the five states, narrowing an untrusted string. */
export function isSuggestionStatus(value: unknown): value is SuggestionStatus {
  return (
    typeof value === 'string' &&
    (SUGGESTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Human-readable reason a transition was refused, for the audit row and the
 * message the staff member sees.
 *
 * Spells out what *is* allowed. A refusal that only says "invalid" makes the
 * operator guess, and guessing at a state machine is how somebody concludes the
 * bot is broken.
 */
export function describeRefusal(
  from: SuggestionStatus,
  to: SuggestionStatus,
): string {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed.length === 0) {
    return `A sugestão está em "${from}", que é um estado final e não aceita mudança.`;
  }
  return `Não dá para ir de "${from}" para "${to}". A partir de "${from}" só: ${allowed.join(', ')}.`;
}
