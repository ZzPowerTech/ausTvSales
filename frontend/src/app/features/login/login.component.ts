import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';

import { AuthService } from '../../core/services/auth.service';

/** Human-readable messages for the `?error=` codes the backend redirects with. */
const ERROR_MESSAGES: Record<string, string> = {
  access_denied:
    'Esta conta do Discord não tem acesso ao painel. Fale com o administrador.',
  oauth_failed: 'Não foi possível concluir o login com o Discord. Tente novamente.',
  invalid_request: 'Sessão de login expirada. Tente novamente.',
};

@Component({
  selector: 'app-login',
  imports: [],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private readonly auth = inject(AuthService);

  /** Bound from the `?error=` query param via `withComponentInputBinding()`. */
  readonly error = input<string | undefined>();

  readonly errorMessage = computed(() => {
    const code = this.error();
    return code ? (ERROR_MESSAGES[code] ?? 'Falha no login. Tente novamente.') : null;
  });

  signIn(): void {
    this.auth.login();
  }
}
