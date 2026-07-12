export type ComponentStatus = 'ok' | 'error' | 'not_configured';

export interface HealthCheckResult {
  status: ComponentStatus;
  components: Record<string, ComponentStatus>;
}
