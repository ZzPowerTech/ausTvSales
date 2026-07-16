import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { AuthUser } from '../../core/models/auth-user.model';
import { AuthService } from '../../core/services/auth.service';
import { DashboardComponent } from './dashboard.component';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

describe('DashboardComponent', () => {
  let fixture: ComponentFixture<DashboardComponent>;
  let logout: jasmine.Spy;

  beforeEach(async () => {
    logout = jasmine.createSpy('logout').and.returnValue(of(undefined));
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { user: signal(USER), logout } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
  });

  it('shows the signed-in username', () => {
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.topbar__name')?.textContent).toContain(
      'Murilo',
    );
  });

  it('logs out when the Sair button is clicked', () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.topbar__logout',
    ) as HTMLButtonElement;
    button.click();
    expect(logout).toHaveBeenCalled();
  });
});
