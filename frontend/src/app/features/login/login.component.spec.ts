import { ComponentRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AuthService } from '../../core/services/auth.service';
import { LoginComponent } from './login.component';

describe('LoginComponent', () => {
  let fixture: ComponentFixture<LoginComponent>;
  let componentRef: ComponentRef<LoginComponent>;
  let login: jasmine.Spy;

  beforeEach(async () => {
    login = jasmine.createSpy('login');
    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [{ provide: AuthService, useValue: { login } }],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginComponent);
    componentRef = fixture.componentRef;
    fixture.detectChanges();
  });

  it('shows the Discord sign-in button and no error by default', () => {
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.login__button')?.textContent).toContain(
      'Entrar com Discord',
    );
    expect(element.querySelector('.login__error')).toBeNull();
  });

  it('maps the access_denied error code to a friendly message', () => {
    componentRef.setInput('error', 'access_denied');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.login__error')?.textContent).toContain(
      'não tem acesso',
    );
  });

  it('starts the login flow on button click', () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.login__button',
    ) as HTMLButtonElement;
    button.click();
    expect(login).toHaveBeenCalled();
  });
});
