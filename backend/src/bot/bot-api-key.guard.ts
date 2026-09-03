import { Injectable, Logger } from '@nestjs/common';
import { ServiceApiKeyGuard } from '../auth/service-auth/service-api-key.guard';
import { BotApiKeyService } from './bot-api-key.service';

/** API-key guard for the bot→API routes. Mechanism in {@link ServiceApiKeyGuard}. */
@Injectable()
export class BotApiKeyGuard extends ServiceApiKeyGuard {
  constructor(apiKeys: BotApiKeyService) {
    super(apiKeys, 'bot', new Logger(BotApiKeyGuard.name));
  }
}
