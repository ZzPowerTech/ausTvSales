import {
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { items, players, sales } from '../db/schema';
import { CreateSaleDto } from './dto/create-sale.dto';

/** Outcome of persisting a sale — drives the controller's 201-vs-200 choice. */
export interface RecordSaleResult {
  saleId: string;
  /** `true` when this call inserted the row; `false` on an idempotent replay. */
  created: boolean;
}

/**
 * Sales ingest persistence (spec S2.2 §2.2).
 *
 * The whole flow runs in a single transaction so the catalog check, the player
 * upsert and the sale insert either all land or none do — a replayed queue entry
 * never leaves a half-written player behind.
 *
 * Idempotency is layered:
 *  - `sales.id` is the client-supplied UUID; the insert uses `ON CONFLICT (id) DO
 *    NOTHING`, so re-sending the same `sale_id` is a no-op that still answers 2xx.
 *  - The primary-key constraint (S1.2) is the last line of defense against the
 *    SQLite fallback queue replaying an event.
 */
@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async record(dto: CreateSaleDto): Promise<RecordSaleResult> {
    return this.db.transaction(async (tx) => {
      // 1. Catalog gate (CA2): an unknown or deactivated item is a *permanent*
      //    error (422). We reject before creating a player or a sale so a bad
      //    item_id never pollutes the catalog-adjacent tables.
      const [item] = await tx
        .select({ active: items.active })
        .from(items)
        .where(eq(items.itemId, dto.item_id))
        .limit(1);

      if (!item || !item.active) {
        this.logger.warn(
          `Rejeitando venda ${dto.sale_id}: item "${dto.item_id}" ` +
            `${item ? 'esta inativo' : 'nao existe'} (422, nao reenfileirar)`,
        );
        throw new UnprocessableEntityException(
          `Item "${dto.item_id}" is not available for sale`,
        );
      }

      // 2. Upsert the player by uuid: the event nickname is the "most recent"
      //    display name. We only write when it actually changed.
      await this.upsertPlayer(tx, dto.player_uuid, dto.nickname_at_purchase);

      // 3. Idempotent insert: ON CONFLICT (id) DO NOTHING. A non-empty RETURNING
      //    means we created the row; an empty one means the sale already existed.
      //    `purchased_at` comes from the payload; `created_at` is stamped by the DB.
      const inserted = await tx
        .insert(sales)
        .values({
          id: dto.sale_id,
          itemId: dto.item_id,
          playerUuid: dto.player_uuid,
          nicknameAtPurchase: dto.nickname_at_purchase,
          totalPrice: dto.total_price.toFixed(2),
          qtd: dto.qtd,
          purchasedAt: new Date(dto.purchased_at),
        })
        .onConflictDoNothing({ target: sales.id })
        .returning({ id: sales.id });

      const created = inserted.length > 0;
      if (!created) {
        this.logger.log(
          `Venda ${dto.sale_id} ja registrada — reenvio idempotente (200)`,
        );
      }
      return { saleId: dto.sale_id, created };
    });
  }

  /**
   * Create the player if unknown; otherwise refresh `last_known_nickname` only
   * when it differs, avoiding a pointless UPDATE (and `updated_at` bump) on every
   * purchase from a returning buyer.
   */
  private async upsertPlayer(
    tx: Parameters<Parameters<DrizzleDB['transaction']>[0]>[0],
    playerUuid: string,
    nickname: string,
  ): Promise<void> {
    const [existing] = await tx
      .select({ lastKnownNickname: players.lastKnownNickname })
      .from(players)
      .where(eq(players.uuid, playerUuid))
      .limit(1);

    if (!existing) {
      await tx
        .insert(players)
        .values({ uuid: playerUuid, lastKnownNickname: nickname });
      return;
    }

    if (existing.lastKnownNickname !== nickname) {
      await tx
        .update(players)
        .set({ lastKnownNickname: nickname, updatedAt: sql`now()` })
        .where(eq(players.uuid, playerUuid));
    }
  }
}
