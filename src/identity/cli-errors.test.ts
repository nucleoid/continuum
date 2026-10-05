import { describe, expect, it } from 'vitest';
import { ServiceError } from '../services/errors.js';
import { cliFailure } from './cli-errors.js';
import { MembershipSnapshotTooLargeError } from './graph-membership.js';

describe('identity CLI errors', () => {
  it('exposes stable service codes and safe public messages', () => {
    expect(JSON.parse(cliFailure(
      'entra_membership_sync_failed',
      new ServiceError('CONFLICT', 'membership sync requires a manual administrator'),
    ))).toEqual({
      event: 'entra_membership_sync_failed',
      code: 'CONFLICT',
      message: 'membership sync requires a manual administrator',
    });
  });

  it('redacts unknown implementation errors', () => {
    expect(JSON.parse(cliFailure(
      'continuum_admin_failed',
      new Error('password=leaked database detail'),
    ))).toEqual({
      event: 'continuum_admin_failed',
      code: 'INTERNAL',
      message: 'An internal error occurred',
    });
  });

  it('reports a Graph whole-run overflow with a stable public code', () => {
    expect(JSON.parse(cliFailure(
      'entra_membership_sync_failed',
      new MembershipSnapshotTooLargeError(),
    ))).toEqual({
      event: 'entra_membership_sync_failed',
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Entra snapshot exceeds the whole-run limit',
    });
  });
});
