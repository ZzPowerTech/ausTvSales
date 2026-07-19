import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { AuthUser } from '../../core/models/auth-user.model';
import { AuthService } from '../../core/services/auth.service';
import { DashboardLayoutComponent } from './dashboard-layout.component';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

/** Stand-ins for the routed catalog screens — this spec is about the shell. */
@Component({ selector: 'app-stub', template: '', standalone: true })
class StubPageComponent {}

describe('DashboardLayoutComponent', () => {
  let fixture: ComponentFixture<DashboardLayoutComponent>;
  let router: Router;
  let logout: jasmine.Spy;

  beforeEach(async () => {
    logout = jasmine.createSpy('logout').and.returnValue(of(undefined));

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
            ],
          },
        ]),
        { provide: AuthService, useValue: { user: signal(USER), logout } },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(DashboardLayoutComponent);
    fixture.detectChanges();
  });

  /** Labels of the nav links currently carrying the active class. */
  const activeLinks = (): string[] =>
    Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.sidenav__link--active',
      ),
    ).map((a) => a.textContent?.trim() ?? '');

  it('shows the signed-in user in the topbar', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Murilo');
  });

  it('renders the catalog navigation links', () => {
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.sidenav__link'),
    ).map((a) => a.textContent?.trim());

    expect(links).toEqual(['Categorias', 'Itens']);
  });

  it('logs out when the topbar button is clicked', () => {
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
    await router.navigate(['/catalog/categories']);
    fixture.detectChanges();
    expect(activeLinks()).toEqual(['Categorias']);

    await router.navigate(['/catalog/items']);
    fixture.detectChanges();
    expect(activeLinks()).toEqual(['Itens']);
  });

  it('marks the current link with aria-current for screen readers', async () => {
    await router.navigate(['/catalog/items']);
    fixture.detectChanges();

    const current = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[aria-current="page"]',
    );
    expect(current.length).toBe(1);
    expect(current[0].textContent?.trim()).toBe('Itens');
  });
});
