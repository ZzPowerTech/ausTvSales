import {
  HEALTH_CHECK_STATUSES,
  HealthCheckName,
  parseCheckName,
  scopedCheckName,
} from './health-check.types';

describe('health-check.types', () => {
  describe('scopedCheckName / parseCheckName', () => {
    it('round-trips a scoped name', () => {
      const persisted = scopedCheckName(
        HealthCheckName.CollectionAlive,
        'survival',
      );

      expect(persisted).toBe('plan.collection_alive:survival');
      expect(parseCheckName(persisted)).toEqual({
        name: 'plan.collection_alive',
        target: 'survival',
      });
    });

    it('reports no target for an unscoped name', () => {
      expect(parseCheckName(HealthCheckName.VersionDivergence)).toEqual({
        name: 'plan.version_divergence',
        target: null,
      });
    });

    it('splits on the first separator so a target may contain one', () => {
      // Server names are operator-supplied; one containing ':' must not silently
      // truncate the target and merge two servers into a single check identity.
      const persisted = scopedCheckName(
        HealthCheckName.CollectionAlive,
        'lobby:eu',
      );

      expect(parseCheckName(persisted)).toEqual({
        name: 'plan.collection_alive',
        target: 'lobby:eu',
      });
    });

    it('keeps an empty target distinguishable from an unscoped name', () => {
      expect(parseCheckName('plan.collection_alive:')).toEqual({
        name: 'plan.collection_alive',
        target: '',
      });
    });
  });

  describe('status vocabulary', () => {
    it('keeps no_data and error as states of their own', () => {
      // The whole point of ADR-006: a collection gap must never be recorded as
      // healthy, and must never be turned into a zero reading either.
      expect(HEALTH_CHECK_STATUSES).toEqual([
        'ok',
        'breached',
        'no_data',
        'error',
      ]);
    });
  });

  describe('check names', () => {
    it('covers the seven checks of spec §6.1', () => {
      expect(Object.values(HealthCheckName)).toHaveLength(7);
    });

    it('keeps every persisted name unique', () => {
      const names = Object.values(HealthCheckName);
      expect(new Set(names).size).toBe(names.length);
    });

    it('never lets a base name contain the scope separator', () => {
      // A ':' inside a base name would make parseCheckName split in the wrong
      // place and silently invent a target.
      for (const name of Object.values(HealthCheckName)) {
        expect(name).not.toContain(':');
      }
    });
  });
});
