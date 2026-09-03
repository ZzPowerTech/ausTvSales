import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceApiKeyService } from '../auth/service-auth/service-api-key.service';

/**
 * The set of API keys accepted from the AusTV Discord bot (story S10.2).
 *
 * A **separate** key set from the plugin's, deliberately. They are different
 * principals on different code paths: the plugin submits sales, the bot moves
 * suggestions. One shared key would mean a leaked bot key can post sales, and
 * rotating one would take down the other.
 *
 * The mechanism is shared and lives in {@link ServiceApiKeyService}.
 * `BOT_API_KEYS` is a deploy secret, comma-separated so a rotation can run with
 * both keys accepted for a window.
 */
@Injectable()
export class BotApiKeyService extends ServiceApiKeyService {
  constructor(config: ConfigService) {
    super(
      config.getOrThrow<string>('BOT_API_KEYS'),
      'BOT_API_KEYS',
      new Logger(BotApiKeyService.name),
    );
  }
}
