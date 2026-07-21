import { isoDateInSaoPaulo, presetRange } from './period';

describe('period utils', () => {
  describe('isoDateInSaoPaulo', () => {
    it('devolve o dia de São Paulo, não o dia UTC', () => {
      // 01:30 UTC de 21/07 ainda é 22:30 de 20/07 em São Paulo (-03:00).
      const utcEarlyMorning = Date.parse('2026-07-21T01:30:00Z');
      expect(isoDateInSaoPaulo(utcEarlyMorning)).toBe('2026-07-20');
    });

    it('coincide com o dia UTC quando não há virada de meia-noite', () => {
      const midday = Date.parse('2026-07-21T15:00:00Z');
      expect(isoDateInSaoPaulo(midday)).toBe('2026-07-21');
    });
  });

  describe('presetRange', () => {
    const now = Date.parse('2026-07-21T15:00:00Z');

    it('7d cobre hoje e os 6 dias anteriores (inclusivo)', () => {
      expect(presetRange(7, now)).toEqual({
        from: '2026-07-15',
        to: '2026-07-21',
      });
    });

    it('1d é o próprio dia', () => {
      expect(presetRange(1, now)).toEqual({
        from: '2026-07-21',
        to: '2026-07-21',
      });
    });

    it('ancora as bordas no calendário de São Paulo', () => {
      const utcEarlyMorning = Date.parse('2026-07-21T01:30:00Z');
      expect(presetRange(7, utcEarlyMorning)).toEqual({
        from: '2026-07-14',
        to: '2026-07-20',
      });
    });
  });
});
