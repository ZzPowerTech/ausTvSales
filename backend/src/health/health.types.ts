export type ComponentStatus = 'ok' | 'error';

export interface HealthCheckResult {
  status: ComponentStatus;
  components: Record<string, ComponentStatus>;
}
