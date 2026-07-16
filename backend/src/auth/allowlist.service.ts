import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The set of Discord user ids allowed to sign in. The product rule is "only two
 * people have access"; this service is the single enforcement point, reading the
 * `ALLOWED_DISCORD_IDS` env allowlist (already format-validated at boot).
 */
@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);
  private readonly allowed: ReadonlySet<string>;

  constructor(config: ConfigService) {
    const raw = config.getOrThrow<string>('ALLOWED_DISCORD_IDS');
    this.allowed = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    );
    // Not a hard failure (the count could legitimately be 1 during a handover),
    // but surface anything other than the expected two for operator awareness.
    if (this.allowed.size !== 2) {
      this.logger.warn(
        `ALLOWED_DISCORD_IDS has ${this.allowed.size} id(s); the intended access is two users`,
      );
    }
  }

  isAllowed(discordId: string): boolean {
    return this.allowed.has(discordId);
  }
}
