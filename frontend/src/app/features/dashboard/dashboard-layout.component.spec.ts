import { Component, WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { AuthUser } from '../../core/models/auth-user.model';
import { Category } from '../../core/models/category.model';
import { AuthService } from '../../core/services/auth.service';
import { CategoriesService } from '../../core/services/categories.service';
import { DashboardLayoutComponent } from './dashboard-layout.component';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

const VIP: Category = { id: 2, name: 'VIP', displayOrder: 0 };
const CAIXAS: Category = { id: 1, name: 'Caixas', displayOrder: 1 };

/** Stand-ins for the routed catalog screens — this spec is about the shell. */
@Component({ selector: 'app-stub', template: '', standalone: true })
class StubPageComponent {}

describe('DashboardLayoutComponent', () => {
  let fixture: ComponentFixture<DashboardLayoutComponent>;
  let router: Router;
  let logout: jasmine.Spy;
  let categoriesSignal: WritableSignal<Category[]>;
  let loadedSignal: WritableSignal<boolean>;
  let list: jasmine.Spy;

  beforeEach(async () => {
    logout = jasmine.createSpy('logout').and.returnValue(of(undefined));
    categoriesSignal = signal<Category[]>([]);
    loadedSignal = signal(false);
    list = jasmine.createSpy('list').and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [DashboardLayoutComponent],
      providers: [
        // Real routes (minus the guard) so `routerLinkActive` has something to
        // match against — the active state is only meaningful under navigation.
        provideRouter([
          {
            path: '',
            children: [
              { path: 'catalog/categories', component: StubPageComponent },
              { path: 'catalog/items', component: StubPageComponent },
              {
                path: 'sales/categories/:categoryId',
                component: StubPageComponent,
              },
            ],
          },
        ]),
        { provide: AuthService, useValue: { user: signal(USER), logout } },
        {
          provide: CategoriesService,
          useValue: {
            categories: categoriesSignal.asReadonly(),
            loaded: loadedSignal.asReadonly(),
            list,
          },
        },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
  });

  /**
   * Create and render the shell. Called from each test **after** the category
   * signals are configured, because the constructor reads `loaded()` on
   * instantiation — creating it in `beforeEach` would freeze that decision.
   */
  const render = (): void => {
    fixture = TestBed.createComponent(DashboardLayoutComponent);
    fixture.detectChanges();
  };

  /** Labels of the nav links currently carrying the active class. */
  const activeLinks = (): string[] =>
    Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.sidenav__link--active',
      ),
    ).map((a) => a.textContent?.trim() ?? '');

  const linkLabels = (): string[] =>
    Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.sidenav__link'),
    ).map((a) => a.textContent?.trim() ?? '');

  it('shows the signed-in user in the topbar', () => {
    render();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Murilo');
  });

  it('keeps the catalog navigation links intact', () => {
    loadedSignal.set(true);
    render();

    // The catalog section is unchanged; the sales entries render below it.
    expect(linkLabels().slice(0, 2)).toEqual(['Categorias', 'Itens']);
  });

  it('loads categories on init when not already loaded', () => {
    render();
    expect(list).toHaveBeenCalled();
  });

  it('does not refetch categories that are already loaded', () => {
    loadedSignal.set(true);
    render();
    expect(list).not.toHaveBeenCalled();
  });

  it('shows a loading hint before categories arrive', () => {
    render();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Carregando categorias');
  });

  it('renders the sales section from the server order, not re-sorted', () => {
    // Server hands them back VIP (order 0) then Caixas (order 1); the nav must
    // mirror that exactly — no client-side sort.
    categoriesSignal.set([VIP, CAIXAS]);
    loadedSignal.set(true);
    render();

    expect(linkLabels()).toEqual(['Categorias', 'Itens', 'VIP', 'Caixas']);
  });

  it('shows an empty state with a catalog link when there are no categories', () => {
    categoriesSignal.set([]);
    loadedSignal.set(true);
    render();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Nenhuma categoria cadastrada');
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      '.sidenav__hint-link',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('/catalog/categories');
  });

  it('logs out when the topbar button is clicked', () => {
    render();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.topbar__logout',
    ) as HTMLButtonElement;
    button.click();

    expect(logout).toHaveBeenCalled();
  });

  it('highlights only the link for the current screen', async () => {
    // Acceptance criterion of S4.1 ("link ativo destacado") — previously
    // untested, so dropping `routerLinkActive` or renaming the class would
    // have shipped a nav with no indication of where you are.
    render();
    await router.navigate(['/catalog/categories']);
    fixture.detectChanges();
    expect(activeLinks()).toEqual(['Categorias']);

    await router.navigate(['/catalog/items']);
    fixture.detectChanges();
    expect(activeLinks()).toEqual(['Itens']);
  });

  it('highlights the active category in the sales section', async () => {
    categoriesSignal.set([VIP, CAIXAS]);
    loadedSignal.set(true);
    render();

    await router.navigate(['/sales/categories', VIP.id]);
    fixture.detectChanges();
    expect(activeLinks()).toEqual(['VIP']);
  });

  it('marks the current link with aria-current for screen readers', async () => {
    render();
    await router.navigate(['/catalog/items']);
    fixture.detectChanges();

    const current = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[aria-current="page"]',
    );
    expect(current.length).toBe(1);
    expect(current[0].textContent?.trim()).toBe('Itens');
  });
});
