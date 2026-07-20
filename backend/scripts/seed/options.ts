import type { SeedOptions } from './dataset';

/**
 * CLI option parsing for the synthetic sales generator (spec S5.0 §1.1).
 *
 * Dates are `YYYY-MM-DD` read in **America/Sao_Paulo**, the project timezone.
 * Brazil abolished DST in 2019, so the fixed `-03:00` offset is correct and
 * stable — no timezone dependency needed for a dev tool. The window is
 * half-open `[from 00:00, to+1d 00:00)`, matching the period semantics the
 * S5.1 endpoints use (spec §2.2), so a dataset generated for a range lines up
 * exactly with the range the dashboard queries.
 */

const BRT_OFFSET = '-03:00';
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class SeedOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedOptionsError';
  }
}

export function parseLocalDate(value: string, flag: string): Date {
  if (!DATE_PATTERN.test(value)) {
    throw new SeedOptionsError(
      `--${flag} deve estar no formato YYYY-MM-DD (recebido: "${value}").`,
    );
  }
  const parsed = new Date(`${value}T00:00:00${BRT_OFFSET}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new SeedOptionsError(`--${flag} nao e uma data valida: "${value}".`);
  }
  return parsed;
}

function readFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      throw new SeedOptionsError(`Argumento nao reconhecido: "${arg}".`);
    }
    const [name, ...rest] = arg.slice(2).split('=');
    if (rest.length === 0) {
      throw new SeedOptionsError(
        `--${name} precisa de um valor no formato --${name}=valor.`,
      );
    }
    flags.set(name, rest.join('='));
  }
  return flags;
}

function readInt(
  flags: Map<string, string>,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new SeedOptionsError(
      `--${name} deve ser um inteiro >= ${min} (recebido: "${raw}").`,
    );
  }
  return parsed;
}

export function parseSeedOptions(argv: readonly string[]): SeedOptions {
  const flags = readFlags(argv);

  const known = new Set([
    'count',
    'from',
    'to',
    'seed',
    'historical-ratio',
    'players',
  ]);
  for (const name of flags.keys()) {
    if (!known.has(name)) {
      throw new SeedOptionsError(
        `Flag desconhecida: --${name}. Conhecidas: ${[...known].join(', ')}.`,
      );
    }
  }

  const count = readInt(flags, 'count', 50_000, 1);
  const playerCount = readInt(flags, 'players', 500, 1);
  const seed = flags.get('seed') ?? 'austv';
  if (seed.length === 0) {
    throw new SeedOptionsError('--seed nao pode ser vazio.');
  }

  const toRaw = flags.get('to');
  const fromRaw = flags.get('from');
  const toStart = toRaw
    ? parseLocalDate(toRaw, 'to')
    : parseLocalDate(new Date().toISOString().slice(0, 10), 'to');
  const from = fromRaw
    ? parseLocalDate(fromRaw, 'from')
    : new Date(toStart.getTime() - 180 * DAY_MS);

  // Half-open window: `--to` is inclusive as a *day*, so the exclusive instant
  // is the start of the following day. Without this, a sale on the last day
  // requested would silently fall outside the dataset.
  const to = new Date(toStart.getTime() + DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw new SeedOptionsError('--from deve ser anterior a --to.');
  }

  const ratioRaw = flags.get('historical-ratio') ?? '0.1';
  const historicalRatio = Number(ratioRaw);
  if (
    !Number.isFinite(historicalRatio) ||
    historicalRatio < 0 ||
    historicalRatio > 1
  ) {
    throw new SeedOptionsError(
      `--historical-ratio deve estar entre 0 e 1 (recebido: "${ratioRaw}").`,
    );
  }

  return { count, from, to, seed, historicalRatio, playerCount };
}
