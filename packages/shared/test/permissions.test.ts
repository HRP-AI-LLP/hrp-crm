import { describe, expect, it } from 'vitest';
import { fieldAccess, hashPassword, mergePermissions, objectPerm, resolveConditionValue, valueSchema, verifyPassword } from '../src';

describe('permission merge', () => {
  const rep = { objects: { '*': { read: 'all' as const, create: true, update: 'own' as const, delete: 'none' as const } }, fields: { lead: { budget: 'hidden' as const } }, conditions: { lead: [{ field: 'city', op: 'eq' as const, value: '$user.region' }] } };
  const viewer = { objects: { lead: { read: 'all' as const } }, fields: { lead: { budget: 'read' as const } } };

  it('takes the most permissive scope across roles', () => {
    const p = mergePermissions([rep, viewer], ['lead']);
    expect(objectPerm(p, 'lead')).toEqual({ read: 'all', create: true, update: 'own', delete: 'none' });
  });
  it('field access is the most permissive across granting roles', () => {
    expect(fieldAccess(mergePermissions([rep], ['lead']), 'lead', 'budget')).toBe('hidden');
    expect(fieldAccess(mergePermissions([rep, viewer], ['lead']), 'lead', 'budget')).toBe('read');
  });
  it('a role without conditions lifts ABAC restrictions', () => {
    expect(mergePermissions([rep], ['lead']).conditions.lead).toHaveLength(1);
    expect(mergePermissions([rep, viewer], ['lead']).conditions.lead).toBeNull();
  });
  it('no granting role → no rows', () => {
    expect(mergePermissions([], ['lead']).conditions.lead).toEqual([]);
  });
  it('resolves $user attributes', () => {
    expect(resolveConditionValue('$user.region', { id: 'u1', attributes: { region: 'west' } })).toBe('west');
    expect(resolveConditionValue('$user.id', { id: 'u1', attributes: {} })).toBe('u1');
  });
});

describe('field validation', () => {
  it('validates by type', () => {
    expect(valueSchema({ key: 'e', label: 'E', type: 'email', standard: false }).safeParse('A@B.co').data).toBe('a@b.co');
    expect(valueSchema({ key: 'p', label: 'P', type: 'percent', standard: false }).safeParse(140).success).toBe(false);
    expect(valueSchema({ key: 'c', label: 'C', type: 'picklist', standard: false, options: { choices: [{ value: 'hot', label: 'Hot' }] } }).safeParse('cold').success).toBe(false);
    expect(valueSchema({ key: 'd', label: 'D', type: 'date', standard: false }).safeParse('2026-10-13').success).toBe(true);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('Correct-Horse-1', 10_000);
    expect(await verifyPassword('Correct-Horse-1', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });
});
