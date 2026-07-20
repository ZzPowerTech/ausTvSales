import { bucketCount } from './analytics.service';

/**
 * The bucket-count estimator backs the §2.8 window cap. It only needs to be an
 * upper bound (reject too-wide windows), but the day case must be exact — that
 * is the one a `?bucket=day` DoS would exploit.
 */
describe('bucketCount', () => {
  it('conta dias de forma inclusiva nas duas pontas', () => {
    expect(bucketCount('2026-01-01', '2026-01-01', 'day')).toBe(1);
    expect(bucketCount('2026-01-01', '2026-01-31', 'day')).toBe(31);
  });

  it('atravessa a virada de ano corretamente', () => {
    // 2026 não é bissexto: 365 dias.
    expect(bucketCount('2026-01-01', '2026-12-31', 'day')).toBe(365);
    // A janela que passa de 366 dias é o que o cap precisa barrar.
    expect(bucketCount('2026-01-01', '2027-01-02', 'day')).toBe(367);
  });

  it('arredonda semanas para cima', () => {
    expect(bucketCount('2026-01-01', '2026-01-07', 'week')).toBe(1);
    expect(bucketCount('2026-01-01', '2026-01-08', 'week')).toBe(2);
  });

  it('conta meses de calendário atravessados', () => {
    expect(bucketCount('2026-01-15', '2026-01-20', 'month')).toBe(1);
    expect(bucketCount('2026-01-31', '2026-03-01', 'month')).toBe(3);
    expect(bucketCount('2026-01-01', '2027-01-01', 'month')).toBe(13);
  });
});
