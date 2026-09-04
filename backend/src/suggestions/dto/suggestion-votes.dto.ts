import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Matches, Max, Min } from 'class-validator';
import { DISCORD_SNOWFLAKE, DISCORD_SNOWFLAKE_MESSAGE } from './discord-id';

/**
 * Largest vote count the column can hold.
 *
 * `votes_up` and `votes_down` are `integer`, so 2^31-1 is not a policy choice —
 * it is the width of the storage. Validated here because the alternative is
 * Postgres answering `integer out of range`, which surfaces as a **500**: the
 * exact failure R4.5 exists to prevent, one order of magnitude further out than
 * the negative case it names.
 *
 * `@IsInt()` alone does not cover it. It is `Number.isInteger`, and
 * `Number.isInteger(1e21)` is `true` — the same hole this repository already
 * found in `clampOffset`, where an unbounded integer reached the driver and
 * came back as a 500 or, worse, as a silently ignored `OFFSET`.
 */
export const VOTE_COUNT_MAX = 2_147_483_647;

/**
 * The vote tally for one suggestion, as an **absolute** value.
 *
 * ## Why absolute and not a delta
 *
 * Decision D2 of the card spec. Discord is the source of truth for the counts;
 * what this table keeps is a snapshot, and a snapshot can go stale when a
 * gateway event is missed. With an absolute write the next event of any kind
 * repairs it. With an increment the drift would be permanent and invisible,
 * because nothing downstream could tell a wrong total from a right one.
 *
 * That also means this route is naturally idempotent and last-writer-wins:
 * replaying the same payload is a no-op, and two overlapping reaction bursts
 * settle on whichever the bot computed last — which is the more recent read of
 * Discord.
 *
 * ## What is deliberately not validated
 *
 * That the numbers are *true*. Anyone holding the bot's service key can write
 * any tally, and no check here could tell an honest count from an invented one.
 * The mitigation is structural rather than syntactic: Discord holds the real
 * count, the bot recomputes it from scratch on every event, and the next write
 * overwrites. A wrong number is transitory by construction (spec §5).
 */
export class SuggestionVotesDto {
  @ApiProperty({
    description: 'Total de 👍, ja descontada a semente do bot. Valor absoluto.',
    minimum: 0,
    maximum: VOTE_COUNT_MAX,
  })
  @IsInt()
  @Min(0)
  @Max(VOTE_COUNT_MAX)
  votes_up!: number;

  @ApiProperty({
    description: 'Total de 👎, ja descontada a semente do bot. Valor absoluto.',
    minimum: 0,
    maximum: VOTE_COUNT_MAX,
  })
  @IsInt()
  @Min(0)
  @Max(VOTE_COUNT_MAX)
  votes_down!: number;
}

/**
 * The route parameter, validated as a snowflake rather than taken on trust.
 *
 * A path segment reaches a `WHERE` clause, and while drizzle parameterizes it,
 * "the driver escapes it" is not the same guarantee as "it is the shape of a
 * Discord id". The narrower reason is diagnostic: without this, a caller that
 * sends a channel id, a URL fragment or an empty segment gets the same **404**
 * as a genuinely unknown message, and R4.4 is explicit that a 404 here means
 * "not a suggestion" — a meaning it loses the moment it also means "malformed".
 */
export class SuggestionMessageParamsDto {
  @ApiProperty({ description: 'Id da mensagem do card no Discord.' })
  @Matches(DISCORD_SNOWFLAKE, {
    message: `discordMsgId ${DISCORD_SNOWFLAKE_MESSAGE}`,
  })
  discordMsgId!: string;
}
