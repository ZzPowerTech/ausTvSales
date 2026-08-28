import { BadRequestException } from '@nestjs/common';
import { FunnelController } from './funnel.controller';
import type { FunnelSeries, FunnelService } from './funnel.service';
import { FunnelGranularity } from './funnel.types';

/**
 * The controller's own rules, without a database.
 *
 * These lived only in `test/funnel.e2e-spec.ts`, which needs Postgres and so
 * only runs in CI — deleting the whole validation guard survived the unit suite.
 * A rule whose only test is CI-gated is a rule that can be removed on a laptop
 * and noticed a day later.
 */
describe('FunnelController', () => {
  let seriesSpy: jest.Mock;
  let controller: FunnelController;

  beforeEach(() => {
    seriesSpy = jest.fn(() => Promise.resolve({} as FunnelSeries));
    controller = new FunnelController({
      series: seriesSpy,
    } as unknown as FunnelService);
  });

  describe('rejects dates that are shaped right and are not real', () => {
    it.each([
      // Parses to NaN. Left through, it reaches the driver and comes back as a
      // query error the service would publish as a source outage — a client
      // typo reading as the game database being down.
      ['2026-01-45'],
      ['2026-13-01'],
      // Parses FINE and rolls: 2026-02-30 becomes 2026-03-02. The window shifts
      // silently, `truncated` stays false, and a date that does not exist is
      // echoed back. Seven of these exist per year.
      ['2026-02-30'],
      ['2026-04-31'],
      ['2026-11-31'],
    ])('answers 400 for from=%s', (from) => {
      expect(() => controller.daily({ from, to: '2026-12-31' })).toThrow(
        BadRequestException,
      );
      expect(seriesSpy).not.toHaveBeenCalled();
    });

    it('answers 400 for an impossible `to` as well', () => {
      expect(() =>
        controller.daily({ from: '2026-01-01', to: '2026-06-31' }),
      ).toThrow(BadRequestException);
    });

    it('accepts a real leap day', async () => {
      // 2028 is a leap year: the guard must not reject a date that exists.
      await controller.daily({ from: '2028-02-29', to: '2028-02-29' });

      expect(seriesSpy).toHaveBeenCalledWith(
        FunnelGranularity.Daily,
        '2028-02-29',
        '2028-02-29',
        'all',
      );
    });

    it('rejects a leap day in a non-leap year', () => {
      expect(() =>
        controller.daily({ from: '2026-02-29', to: '2026-03-01' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('rejects an inverted period', () => {
    it('answers 400 when from is after to', () => {
      expect(() =>
        controller.daily({ from: '2026-03-10', to: '2026-03-01' }),
      ).toThrow(BadRequestException);
      expect(seriesSpy).not.toHaveBeenCalled();
    });

    it('accepts a single-day window', async () => {
      await controller.daily({ from: '2026-03-10', to: '2026-03-10' });

      expect(seriesSpy).toHaveBeenCalled();
    });
  });

  describe('defaults', () => {
    it('uses a 30-day window for the daily route', async () => {
      await controller.daily({ to: '2026-03-31' });

      const [, from, to] = seriesSpy.mock.calls[0] as [
        string,
        string,
        string,
        string,
      ];
      expect(to).toBe('2026-03-31');
      expect(from).toBe('2026-03-01');
    });

    it('uses a year for the monthly route', async () => {
      await controller.monthly({ to: '2026-12-31' });

      const [granularity, from] = seriesSpy.mock.calls[0] as [
        string,
        string,
        string,
        string,
      ];
      expect(granularity).toBe(FunnelGranularity.Monthly);
      expect(from).toBe('2025-12-31');
    });

    it('passes `all` when no platform is given', async () => {
      await controller.daily({ from: '2026-03-01', to: '2026-03-02' });

      expect(seriesSpy).toHaveBeenCalledWith(
        FunnelGranularity.Daily,
        '2026-03-01',
        '2026-03-02',
        'all',
      );
    });

    it('forwards the platform when one is given', async () => {
      await controller.daily({
        from: '2026-03-01',
        to: '2026-03-02',
        platform: 'bedrock',
      });

      expect(seriesSpy).toHaveBeenCalledWith(
        FunnelGranularity.Daily,
        '2026-03-01',
        '2026-03-02',
        'bedrock',
      );
    });
  });
});
