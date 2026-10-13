import type { FieldDef } from './fields';
import type { EffectivePermissions } from './permissions';

/** Shapes exchanged between the API and the SPA. */

export interface ObjectMeta {
  key: string;
  label: string;
  plural: string;
  icon: string | null;
  isStandard: boolean;
  moduleKey: string | null;
  fields: FieldDef[];
}

export interface StageMeta {
  id: string;
  key: string;
  label: string;
  position: number;
  probability: number;
  category: 'open' | 'won' | 'lost';
  color: string | null;
}

export interface PipelineMeta {
  id: string;
  objectKey: string;
  name: string;
  isDefault: boolean;
  stages: StageMeta[];
}

export interface TenantMeta {
  tenant: { id: string; slug: string; name: string; metaVersion: number };
  objects: ObjectMeta[];
  pipelines: PipelineMeta[];
  modules: { key: string; version: string; enabled: boolean }[];
}

export interface MeResponse {
  user: { id: string; email: string; fullName: string; isOwner: boolean; roles: string[]; attributes: Record<string, unknown> };
  tenant: { id: string; slug: string; name: string };
  permissions: EffectivePermissions;
}

export interface RecordDto {
  id: string;
  object: string;
  title: string;
  version: number;
  created_at: string;
  updated_at: string;
  [field: string]: unknown;
}

export interface ListResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
