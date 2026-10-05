import { describe, expect, it } from 'vitest';
import { parseAuditRetentionCliOptions } from './audit-retention-cli.js';

describe('audit-retention CLI options', () => {
  it.each([{}, { CONTINUUM_AUDIT_RETENTION_DAYS: '' }])(
    'keeps retention disabled when days is unset or empty',
    (env) => {
      expect(parseAuditRetentionCliOptions([], env)).toEqual({ enabled: false });
    },
  );

  it('ignores malformed tuning when retention is disabled', () => {
    expect(parseAuditRetentionCliOptions(['--batch-size'], {
      CONTINUUM_AUDIT_RETENTION_BATCH_SIZE: 'not-a-number',
      CONTINUUM_AUDIT_RETENTION_MAX_BATCHES: '-1',
      CONTINUUM_AUDIT_RETENTION_MAX_ROWS: '1.5',
      CONTINUUM_AUDIT_RETENTION_EXPORT_DIR: 'relative/path',
    })).toEqual({ enabled: false });
  });

  it('still rejects unknown arguments when retention is disabled', () => {
    expect(() => parseAuditRetentionCliOptions(['--unknown'], {})).toThrow('Unknown argument');
  });

  it('accepts strict bounded environment configuration', () => {
    expect(parseAuditRetentionCliOptions([], {
      CONTINUUM_AUDIT_RETENTION_DAYS: '90',
      CONTINUUM_AUDIT_RETENTION_BATCH_SIZE: '250',
      CONTINUUM_AUDIT_RETENTION_MAX_BATCHES: '4',
      CONTINUUM_AUDIT_RETENTION_MAX_ROWS: '777',
      CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID: 'svc:audit-retention',
      CONTINUUM_AUDIT_RETENTION_EXPORT_DIR: '/secure/audit-archive',
    })).toEqual({
      enabled: true,
      retentionDays: 90,
      batchSize: 250,
      maxBatches: 4,
      maxRows: 777,
      principalExternalId: 'svc:audit-retention',
      exportDirectory: '/secure/audit-archive',
      dryRun: false,
    });
  });

  it('allows bounded command-line overrides', () => {
    expect(parseAuditRetentionCliOptions([
      '--dry-run', '--batch-size', '7', '--max-batches', '2', '--max-rows', '9',
    ], {
      CONTINUUM_AUDIT_RETENTION_DAYS: '30',
      CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID: 'local-admin',
    })).toMatchObject({
      enabled: true, dryRun: true, batchSize: 7, maxBatches: 2, maxRows: 9,
    });
  });

  it.each([
    { CONTINUUM_AUDIT_RETENTION_DAYS: '0' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '-1' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '1.5' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: ' 30' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_BATCH_SIZE: '0' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_BATCH_SIZE: '1001' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_MAX_BATCHES: '0' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_MAX_BATCHES: '1001' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_MAX_ROWS: '0' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_MAX_ROWS: '100001' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID: '' },
    { CONTINUUM_AUDIT_RETENTION_DAYS: '30', CONTINUUM_AUDIT_RETENTION_EXPORT_DIR: 'relative/path' },
  ])('rejects invalid enabled configuration %#', (env) => {
    expect(() => parseAuditRetentionCliOptions([], env)).toThrow();
  });

  it.each([
    ['--unknown'], ['--batch-size'], ['--batch-size', '01'], ['--max-batches', '-1'],
    ['--max-rows', '1.5'],
  ])('rejects invalid arguments: %j', (args) => {
    expect(() => parseAuditRetentionCliOptions(args, {
      CONTINUUM_AUDIT_RETENTION_DAYS: '30',
      CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID: 'local-admin',
    })).toThrow();
  });
});
