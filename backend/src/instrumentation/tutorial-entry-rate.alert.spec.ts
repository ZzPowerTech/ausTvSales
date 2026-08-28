import { ConfigService } from '@nestjs/config';
import type { TutorialStore } from '../tutorial/tutorial.store';
import { DiscordAlerter } from './discord-alerter';
import type { PlanApiClient } from './plan-api.client';
import { PlanServersConfig } from './plan-servers.config';
import { TutorialEntryRateCheck } from './tutorial-entry-rate.check';
import { decideAlerts } from './alert-policy';
import type { HealthCheckRecord } from './health-check.types';

/**
 * Criterion 5 of story S8.0, inherited from S6.3: **"alerta testado com valor
 * forçado"**.
 *
 * ## What this proves, and what it does not
 *
 * It forces the tutorial entry rate to a breaching value and follows the
 * verdict through the two stages that decide whether anyone hears about it —
 * `decideAlerts` and `DiscordAlerter.publish` — asserting on the exact HTTP
 * payload that would go to the webhook.
 *
 * **It does not replace criterion 4 of S6.3** ("verified by taking an instance
 * down on purpose"), which is still open and needs a real environment. The
 * difference matters and is the whole subject of
 * `.specs/features/austv-admin/S6-VERIFICACAO.md`: this test proves the message
 * is *built* correctly from a breaching reading. Only production proves it
 * *arrives*.
 *
 * What it does close is the narrower question the criterion actually asks —
 * that a forced value produces an alert rather than a silent row.
 */

const SERVERS = new PlanServersConfig({
  get: <T>(key: string): T | undefined =>
    ({ PLAN_SERVERS: 'AusTv,Survival', PLAN_PROXY_SERVER: 'AusTv' })[key] as
      T | undefined,
} as unknown as ConfigService);

const WEBHOOK = 'https://discord.com/api/webhooks/1/forced-value-test';

function alerterConfig(): ConfigService {
  return {
    get: <T>(key: string): T | undefined =>
      ({ DISCORD_ALERT_WEBHOOK_URL: WEBHOOK })[key] as T | undefined,
  } as unknown as ConfigService;
}

/** The forced reading: 12 of 100 newcomers entered — the april/2026 figure. */
const FORCED_ENTERED = 12;
const FORCED_ARRIVALS = 100;

function buildCheck(): TutorialEntryRateCheck {
  const plan = {
    getJson: jest.fn(() =>
      Promise.resolve({
        timestamp: 1787494648039,
        last_7_days: { new_players: FORCED_ARRIVALS },
        numbers: {},
      }),
    ),
  } as unknown as PlanApiClient;

  const store = {
    lastSuccessfulSync: jest.fn(() =>
      Promise.resolve({
        id: 1,
        ranAt: new Date(Date.now() - 3_600_000),
        status: 'ok',
      }),
    ),
    enteredSince: jest.fn(() => Promise.resolve(FORCED_ENTERED)),
  } as unknown as TutorialStore;

  return new TutorialEntryRateCheck(plan, SERVERS, store, {
    get: () => undefined,
  } as unknown as ConfigService);
}

describe('funnel.tutorial_entry_rate — alerta com valor forcado (S8.0 criterio 5)', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a forced 12% produces a Discord message carrying the value and its base', async () => {
    const observations = await buildCheck().run();
    expect(observations).toHaveLength(1);
    expect(observations[0].status).toBe('breached');

    // The runner persists first and hands the stored rows to the policy. Stand in
    // for the store with the row it would have written.
    const stored: HealthCheckRecord[] = observations.map((observation, i) => ({
      id: i + 1,
      checkName: observation.checkName,
      status: observation.status,
      checkedAt: new Date(),
      detail: observation.detail,
      alertedAt: null,
    }));

    const decision = decideAlerts({
      observations: stored,
      previousStatus: new Map(),
      lastAlertAt: new Map(),
      reAlertAfterMs: 24 * 3_600_000,
      now: new Date(),
    });

    // A first-time breach must announce; grouping only applies to repeats.
    expect(decision.announce).toHaveLength(1);

    const alerter = new DiscordAlerter(alerterConfig());
    const delivered = await alerter.publish(decision);

    expect(delivered).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(WEBHOOK);

    const payload = JSON.parse(init.body) as {
      content: string;
      embeds: { fields: { name: string; value: string }[] }[];
      allowed_mentions: { parse: string[] };
    };
    const message = JSON.stringify(payload);

    // The forced value reaches the channel...
    expect(message).toContain('12%');
    // ...and so does the base it was computed from. The project rule is that no
    // percentage is published without it, and an alert is the place where
    // somebody is about to act on the number.
    expect(message).toContain(String(FORCED_ARRIVALS));
    // The check name arrives markdown-escaped — `_` would italicise otherwise,
    // and the alerter escapes every field it did not author. Asserting on the
    // escaped form rather than loosening the match: the escaping is a property
    // worth pinning, not an inconvenience to work around.
    expect(payload.embeds[0].fields[0].name).toBe(
      'funnel.tutorial\\_entry\\_rate \\(Survival\\)',
    );
    // The message says what the number means, not just what it is.
    expect(message).toContain('entraram no tutorial');
    // Every mention is inert, whatever a check detail happens to contain.
    expect(payload.allowed_mentions.parse).toEqual([]);
  });

  it('the webhook URL is never echoed into the message body', async () => {
    // The URL *is* the credential — anyone holding it can post to the channel.
    const decision = decideAlerts({
      observations: (await buildCheck().run()).map((observation) => ({
        id: 1,
        checkName: observation.checkName,
        status: observation.status,
        checkedAt: new Date(),
        detail: observation.detail,
        alertedAt: null,
      })),
      previousStatus: new Map(),
      lastAlertAt: new Map(),
      reAlertAfterMs: 24 * 3_600_000,
      now: new Date(),
    });

    await new DiscordAlerter(alerterConfig()).publish(decision);

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(init.body).not.toContain('forced-value-test');
  });

  it('reports honestly that nothing was delivered when no webhook is configured', async () => {
    // The failure mode this guards: an alerter that returns "delivered" without a
    // webhook would let the runner stamp `alerted_at`, and the policy would then
    // group the breach away for a whole day. The outage would go quiet while the
    // database claimed it had been reported.
    const decision = decideAlerts({
      observations: (await buildCheck().run()).map((observation) => ({
        id: 1,
        checkName: observation.checkName,
        status: observation.status,
        checkedAt: new Date(),
        detail: observation.detail,
        alertedAt: null,
      })),
      previousStatus: new Map(),
      lastAlertAt: new Map(),
      reAlertAfterMs: 24 * 3_600_000,
      now: new Date(),
    });

    const alerter = new DiscordAlerter({
      get: () => undefined,
    } as unknown as ConfigService);

    await expect(alerter.publish(decision)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
