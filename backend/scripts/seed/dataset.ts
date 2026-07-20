import {
  createRng,
  cumulative,
  intBetween,
  pickWeighted,
  powerLawWeights,
  type Rng,
} from './rng';
import { deterministicUuid } from './uuid';

/**
 * Pure dataset construction for the synthetic sales generator (spec S5.0 §1.5).
 *
 * No database access lives here on purpose: every rule that the review actually
 * cares about (nickname drift proving CA4, `historical_import` semantics, money
 * arithmetic) is then testable without a Postgres instance.
 *
 * The generator reproduces by hand the invariants that `POST /sales` would have
 * enforced — active item, player upserted before the sale, `qtd > 0`,
 * `total_price > 0` — because it writes straight to the database (§1.2). The
 * schema `CHECK`s remain the backstop.
 */

export interface SeedOptions {
  count: number;
  /** Window start, inclusive. */
  from: Date;
  /** Window end, exclusive instant (the CLI passes the start of `--to` + 1 day). */
  to: Date;
  seed: string;
  /** Share of rows written as `historical_import = true`, 0..1. */
  historicalRatio: number;
  playerCount: number;
}

export interface GeneratedPlayer {
  uuid: string;
  lastKnownNickname: string;
}

export interface GeneratedSale {
  id: string;
  itemId: string;
  playerUuid: string;
  nicknameAtPurchase: string;
  /** Decimal string, never a float — mirrors `numeric(12,2)` (spec §2.5). */
  totalPrice: string;
  qtd: number;
  purchasedAt: Date;
  historicalImport: boolean;
}

export interface Dataset {
  players: GeneratedPlayer[];
  sales: GeneratedSale[];
}

const DAY_MS = 86_400_000;
const NICKNAME_CHANGE_SHARE = 0.2;
const SPIKE_DAYS = 5;
const SPIKE_SHARE = 0.35;

interface NicknameEntry {
  nick: string;
  fromMs: number;
}

interface PlayerPlan {
  uuid: string;
  nicknames: NicknameEntry[];
}

/** Money is integer cents end to end; `numeric(12,2)` never sees a float. */
function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Nickname timeline per player. ~20% of players rename 1–2 times inside the
 * window, which is what lets the dashboard prove CA4 on screen: the ranking must
 * show `players.last_known_nickname`, not the `nickname_at_purchase` snapshot
 * frozen on the older rows.
 */
function planPlayers(options: SeedOptions, rng: Rng): PlayerPlan[] {
  const windowStart = options.from.getTime();
  const windowSpan = Math.max(options.to.getTime() - windowStart, DAY_MS);

  return Array.from({ length: options.playerCount }, (_, index) => {
    const uuid = deterministicUuid(options.seed, 'player', index);
    const base = `AusTV_${String(index).padStart(4, '0')}`;
    const nicknames: NicknameEntry[] = [
      // Sentinel epoch: historical rows sit before the window and must still
      // resolve to the player's first known nickname.
      { nick: base, fromMs: Number.NEGATIVE_INFINITY },
    ];

    if (rng() < NICKNAME_CHANGE_SHARE) {
      const renames = intBetween(rng, 1, 2);
      const changePoints: number[] = [];
      for (let r = 0; r < renames; r += 1) {
        changePoints.push(windowStart + Math.floor(rng() * windowSpan));
      }
      changePoints.sort((a, b) => a - b);
      changePoints.forEach((fromMs, r) => {
        nicknames.push({ nick: `${base}_v${r + 2}`, fromMs });
      });
    }

    return { uuid, nicknames };
  });
}

function nicknameAt(plan: PlayerPlan, atMs: number): string {
  let current = plan.nicknames[0].nick;
  for (const entry of plan.nicknames) {
    if (entry.fromMs <= atMs) {
      current = entry.nick;
    }
  }
  return current;
}

/**
 * Timestamps clustered around a handful of spike days (crate launches), not
 * uniform. A flat distribution would render a flat chart and quietly make the
 * CA5 demo prove nothing.
 */
function purchaseInstant(
  rng: Rng,
  options: SeedOptions,
  spikeStarts: number[],
): Date {
  const windowStart = options.from.getTime();
  const windowSpan = Math.max(options.to.getTime() - windowStart, 1);

  if (rng() < SPIKE_SHARE) {
    const spikeStart = spikeStarts[intBetween(rng, 0, spikeStarts.length - 1)];
    const withinDay = Math.floor(rng() * DAY_MS);
    const at = spikeStart + withinDay;
    if (at < options.to.getTime()) {
      return new Date(at);
    }
  }

  return new Date(windowStart + Math.floor(rng() * windowSpan));
}

export function buildDataset(
  options: SeedOptions,
  itemIds: readonly string[],
): Dataset {
  if (itemIds.length === 0) {
    throw new Error(
      'Nenhum item ativo no catalogo — cadastre itens antes de gerar vendas.',
    );
  }

  const rng = createRng(options.seed);
  const plans = planPlayers(options, rng);

  // Items carry no price in the catalog (price comes from the Genesis
  // placeholder at sale time, spec §3), so the generator invents a stable unit
  // price per item — in cents, so totals stay exact.
  const unitPriceCents = itemIds.map(() => intBetween(rng, 5_000, 500_000));

  const itemWeights = cumulative(powerLawWeights(itemIds.length));
  const playerWeights = cumulative(powerLawWeights(plans.length));

  const windowStart = options.from.getTime();
  const windowSpan = Math.max(options.to.getTime() - windowStart, DAY_MS);
  const spikeStarts = Array.from({ length: SPIKE_DAYS }, () => {
    const offsetDays = Math.floor((rng() * windowSpan) / DAY_MS);
    return windowStart + offsetDays * DAY_MS;
  });

  // A single fixed instant before the window, mirroring the Sprint 6 migration:
  // the historical rows have no real per-event timestamp, so inventing granular
  // fake ones would be the exact pollution CA7 forbids.
  const historicalInstant = new Date(windowStart - DAY_MS);
  const historicalCount = Math.round(options.count * options.historicalRatio);

  const sales: GeneratedSale[] = [];
  const usedPlayers = new Map<number, PlayerPlan>();

  for (let index = 0; index < options.count; index += 1) {
    const historicalImport = index < historicalCount;
    const itemIndex = pickWeighted(rng, itemWeights);
    const playerIndex = pickWeighted(rng, playerWeights);
    const plan = plans[playerIndex];
    usedPlayers.set(playerIndex, plan);

    const purchasedAt = historicalImport
      ? historicalInstant
      : purchaseInstant(rng, options, spikeStarts);
    const qtd = intBetween(rng, 1, 5);

    sales.push({
      id: deterministicUuid(options.seed, 'sale', index),
      itemId: itemIds[itemIndex],
      playerUuid: plan.uuid,
      nicknameAtPurchase: nicknameAt(plan, purchasedAt.getTime()),
      totalPrice: formatCents(unitPriceCents[itemIndex] * qtd),
      qtd,
      purchasedAt,
      historicalImport,
    });
  }

  const players: GeneratedPlayer[] = [...usedPlayers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, plan]) => ({
      uuid: plan.uuid,
      // The most recent entry wins — this is the value the CA4 ranking shows.
      lastKnownNickname: plan.nicknames[plan.nicknames.length - 1].nick,
    }));

  return { players, sales };
}
