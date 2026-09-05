import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The scope a route requires when it wants "a member of staff", not merely
 * "somebody who can sign in".
 *
 * A single named scope rather than a permission system: the product has two
 * dashboard users and one privileged action, and a role table would be
 * machinery with nothing to hold.
 */
export const STAFF_SCOPE = 'suggestions:write';

/**
 * Who counts as staff for the purposes of {@link STAFF_SCOPE} (story S11.1,
 * criterion 3).
 *
 * ## Where the scope is resolved, and why not in the JWT
 *
 * The session token carries identity and nothing else. The scope is decided
 * **per request**, from configuration, exactly as {@link AllowlistService} is
 * consulted per request by the global guard — and for the same reason: a scope
 * frozen into a cookie that lives for days is a scope that cannot be revoked
 * for as long as that cookie lives. Removing an id from the variable has to
 * take effect on the next request, not on the next login.
 *
 * So "JWT com escopo de staff" is honest in the form that matters: the JWT
 * authenticates, and the authorization is checked server-side against live
 * configuration on every call. What it is *not* is a `scopes` claim the client
 * carries around, which would be the same word describing a weaker property.
 *
 * ## The fallback, and the fact that it is vacuous today
 *
 * `STAFF_DISCORD_IDS` is **optional**. Absent, staff is the whole dashboard
 * allowlist — so today, with two people on it and both of them staff, this check
 * refuses nobody. Saying that plainly is the point: the mechanism exists so the
 * two sets can diverge without a code change, and pretending it already
 * separates them would be claiming a control that is not doing work yet.
 *
 * Optional rather than required for a deployment reason this repo has paid for
 * once: a new **mandatory** variable fails validation at boot, and this project
 * releases automatically on merge — the container would crash-loop until
 * somebody set it on the VPS. A narrowing that has to be switched on is safe;
 * one that takes production down to be switched on is not.
 */
@Injectable()
export class StaffScopeService {
  private readonly logger = new Logger(StaffScopeService.name);
  private readonly staff: ReadonlySet<string>;

  /** Whether the set came from its own variable or from the login allowlist. */
  readonly source: 'staff_list' | 'admin_allowlist';

  constructor(config: ConfigService) {
    const explicit = parseIds(config.get<string>('STAFF_DISCORD_IDS'));

    if (explicit.size > 0) {
      this.staff = explicit;
      this.source = 'staff_list';
      this.logger.log(
        `Escopo de staff: ${explicit.size} id(s) de STAFF_DISCORD_IDS`,
      );
      return;
    }

    this.staff = parseIds(config.getOrThrow<string>('ALLOWED_DISCORD_IDS'));
    this.source = 'admin_allowlist';
    // Logged at boot, and worded so the operator reads it as a state rather
    // than as an error: it is the intended default, and it is also the reason
    // the staff check currently refuses nobody.
    this.logger.log(
      `Escopo de staff: STAFF_DISCORD_IDS ausente, entao TODO usuario do ` +
        `dashboard (${this.staff.size}) e staff. Defina STAFF_DISCORD_IDS para ` +
        'separar os dois conjuntos.',
    );
  }

  /** Whether this Discord user may perform staff writes. */
  isStaff(discordId: string): boolean {
    return this.staff.has(discordId);
  }
}

function parseIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}
