import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { AuthUser } from '../../core/models/auth-user.model';
import { AuthService } from '../../core/services/auth.service';
import { DashboardLayoutComponent } from './dashboard-layout.component';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

describe('DashboardLayoutComponent', () => {
  let fixture: ComponentFixture<DashboardLayoutComponent>;
  let logout: jasmine.Spy;

  beforeEach(async () => {
    logout = jasmine.createSpy('logout').and.returnValue(of(undefined));

    await TestBed.configureTestingModule({
      imports: [DashboardLayoutComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { user: signal(USER), logout } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardLayoutComponent);
    fixture.detectChanges();
  });

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
});
