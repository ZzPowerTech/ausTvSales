import { ConfigService } from '@nestjs/config';
import { IngestIpAllowlistService } from './ingest-ip-allowlist.service';

function buildService(raw: string | undefined): IngestIpAllowlistService {
  const config = {
    get: jest.fn().mockReturnValue(raw),
  } as unknown as ConfigService;
  return new IngestIpAllowlistService(config);
}

describe('IngestIpAllowlistService', () => {
  describe('enabled allowlist', () => {
    it('allows an exact IPv4 match and rejects anything else', () => {
      const service = buildService('203.0.113.10');
      expect(service.enabled).toBe(true);
      expect(service.isAllowed('203.0.113.10')).toBe(true);
      expect(service.isAllowed('203.0.113.11')).toBe(false);
    });

    it('accepts a comma-separated list with surrounding whitespace', () => {
      const service = buildService(' 203.0.113.10 , 198.51.100.5 ');
      expect(service.isAllowed('203.0.113.10')).toBe(true);
      expect(service.isAllowed('198.51.100.5')).toBe(true);
      expect(service.isAllowed('192.0.2.1')).toBe(false);
    });

    it('matches an IPv4-mapped IPv6 client against an IPv4 allowlist entry', () => {
      const service = buildService('203.0.113.10');
      expect(service.isAllowed('::ffff:203.0.113.10')).toBe(true);
    });

    it('allows an exact IPv6 match (case-insensitive)', () => {
      const service = buildService('2001:DB8::1');
      expect(service.isAllowed('2001:db8::1')).toBe(true);
      expect(service.isAllowed('2001:db8::2')).toBe(false);
    });

    it('rejects a missing IP', () => {
      const service = buildService('203.0.113.10');
      expect(service.isAllowed(undefined)).toBe(false);
    });

    it('throws at construction on a malformed IP (fail at boot)', () => {
      expect(() => buildService('203.0.113.10,not-an-ip')).toThrow(
        /invalid IP address/i,
      );
    });

    it('throws on a CIDR range (exact IPs only at the app layer)', () => {
      expect(() => buildService('203.0.113.0/24')).toThrow(
        /invalid IP address/i,
      );
    });
  });

  describe('disabled allowlist (unset in dev)', () => {
    it('is disabled and allows everything when unset', () => {
      const service = buildService(undefined);
      expect(service.enabled).toBe(false);
      expect(service.isAllowed('203.0.113.10')).toBe(true);
      expect(service.isAllowed('192.0.2.1')).toBe(true);
      expect(service.isAllowed(undefined)).toBe(true);
    });

    it('is disabled when the value is blank/only separators', () => {
      expect(buildService('   ').enabled).toBe(false);
      expect(buildService(' , ').enabled).toBe(false);
    });
  });
});
