import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Chart } from 'chart.js';
import { Observable, of, throwError } from 'rxjs';

import { SeriesReport } from '../../../core/models/analytics.model';
import { AnalyticsService } from '../../../core/services/analytics.service';
import { SalesSeriesChartComponent } from './sales-series-chart.component';

const REPORT: SeriesReport = {
  itemId: 'caixaNatal2026',
  bucket: 'day',
  points: [
    { at: '2026-07-01', qty: 12, revenue: '1440.00' },
    { at: '2026-07-02', qty: 5, revenue: '600.30' },
  ],
  excludedHistorical: { qty: 300, revenue: '36000.00' },
};

const EMPTY_REPORT: SeriesReport = {
  itemId: 'caixaNatal2026',
  bucket: 'day',
  points: [],
  excludedHistorical: { qty: 0, revenue: '0.00' },
};

describe('SalesSeriesChartComponent', () => {
  let fixture: ComponentFixture<SalesSeriesChartComponent>;
  let component: SalesSeriesChartComponent;
  let series: jasmine.Spy;

  const setup = async (
    response: Observable<SeriesReport>,
    itemId = 'caixaNatal2026',
  ): Promise<void> => {
    series = jasmine.createSpy('series').and.returnValue(response);
    TestBed.configureTestingModule({
      imports: [SalesSeriesChartComponent],
      providers: [{ provide: AnalyticsService, useValue: { series } }],
    });
    fixture = TestBed.createComponent(SalesSeriesChartComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('itemId', itemId);
    fixture.detectChanges();
    await fixture.whenStable();
    // Second pass so the render effect sees the canvas the @if just revealed.
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const text = (): string =>
    (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('renders a chart with the qty series when there are points', async () => {
    await setup(of(REPORT));

    expect(series).toHaveBeenCalledWith(
      'caixaNatal2026',
      jasmine.anything(),
      'day',
    );
    expect(component.hasChartInstance).toBeTrue();
    expect(component.chartDatasetValues).toEqual([12, 5]);
  });

  it('shows the empty state and no canvas when the window has no sales', async () => {
    await setup(of(EMPTY_REPORT));

    expect(component.isEmpty()).toBeTrue();
    expect(component.hasChartInstance).toBeFalse();
    expect(text()).toContain('Sem vendas no período');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('canvas'),
    ).toBeNull();
  });

  it('surfaces excludedHistorical as a textual baseline, never a point', async () => {
    await setup(of(REPORT));

    expect(text()).toContain('Histórico pré-migração');
    expect(text()).toContain('300 vendas');
    expect(text()).toContain('36.000,00');
    // The baseline is not among the plotted values.
    expect(component.chartDatasetValues).not.toContain(300);
  });

  it('omits the baseline when there is no pre-migration history', async () => {
    await setup(of(EMPTY_REPORT));
    expect(component.hasExcludedHistorical()).toBeFalse();
    expect(text()).not.toContain('Histórico pré-migração');
  });

  it('rewrites the dataset (not the instance) when toggling qty ↔ revenue', async () => {
    await setup(of(REPORT));
    const destroySpy = spyOn(Chart.prototype, 'destroy').and.callThrough();

    component.setMode('revenue');
    fixture.detectChanges();

    expect(component.plottedValues()).toEqual([1440, 600.3]);
    expect(component.chartDatasetValues).toEqual([1440, 600.3]);
    // Toggling must update in place — the instance is not torn down/rebuilt.
    expect(destroySpy).not.toHaveBeenCalled();
    expect(component.hasChartInstance).toBeTrue();
  });

  it('exposes an aria-label summarising the series on the canvas', async () => {
    await setup(of(REPORT));
    const canvas = (fixture.nativeElement as HTMLElement).querySelector(
      'canvas',
    );
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toContain('caixaNatal2026');
  });

  it('renders a screen-reader table mirroring the points', async () => {
    await setup(of(REPORT));
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'table.sr-only tbody tr',
    );
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('2026-07-01');
    expect(rows[0].textContent).toContain('1.440,00');
  });

  it('shows an error state when the series request fails', async () => {
    await setup(throwError(() => new Error('boom')));
    expect(component.loadError()).toBeTrue();
    expect(component.hasChartInstance).toBeFalse();
    expect(text()).toContain('Não foi possível carregar');
  });

  it('destroys the chart on teardown, leaving no instance behind', async () => {
    await setup(of(REPORT));
    expect(component.hasChartInstance).toBeTrue();

    fixture.destroy();

    expect(component.hasChartInstance).toBeFalse();
  });

  it('reloads and updates the chart in place when the period changes', async () => {
    await setup(of(REPORT));
    const updateSpy = spyOn(Chart.prototype, 'update').and.callThrough();
    const destroySpy = spyOn(Chart.prototype, 'destroy').and.callThrough();
    const next: SeriesReport = {
      ...REPORT,
      points: [{ at: '2026-08-01', qty: 9, revenue: '1080.00' }],
    };
    series.and.returnValue(of(next));

    fixture.componentRef.setInput('period', { from: '2026-08-01' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.chartDatasetValues).toEqual([9]);
    expect(updateSpy).toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
  });
});
