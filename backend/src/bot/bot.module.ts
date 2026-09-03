import { Module } from '@nestjs/common';
import { ThrottlingModule } from '../config/throttling';
import { BotApiKeyGuard } from './bot-api-key.guard';
import { BotApiKeyService } from './bot-api-key.service';
import { BotIpAllowlistGuard } from './bot-ip-allowlist.guard';
import { BotIpAllowlistService } from './bot-ip-allowlist.service';

/**
 * Authentication foundation for the AusTV Discord bot as an API client
 * (story S10.2): its own key set, its own source-IP allowlist, and the rate
 * limit shared by every bot→API route.
 *
 * Deliberately separate from `IngestModule` even though the mechanism is shared.
 * The two are different principals with different keys, different allowlists and
 * different blast radius — the folder boundary is what stops a future route from
 * accidentally accepting whichever key happens to be injected.
 *
 * The throttler root lives in {@link ThrottlingModule}; this module re-exports
 * it so `@BotAuth()`'s `ThrottlerGuard` resolves its options wherever a bot
 * controller is hosted.
 */
@Module({
  imports: [ThrottlingModule],
  providers: [
    BotApiKeyService,
    BotApiKeyGuard,
    BotIpAllowlistService,
    BotIpAllowlistGuard,
  ],
  exports: [
    BotApiKeyService,
    BotApiKeyGuard,
    BotIpAllowlistService,
    BotIpAllowlistGuard,
    ThrottlingModule,
  ],
})
export class BotModule {}
