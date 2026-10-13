import type { ListResponse, ObjectMeta, PipelineMeta, RecordDto, TenantMeta } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => get<TenantMeta>('/api/v1/meta'), staleTime: 60_000 });
}

export function useObject(key: string | undefined): ObjectMeta | undefined {
  const { data } = useMeta();
  return data?.objects.find((o) => o.key === key);
}

export function usePipelines(objectKey: string | undefined): PipelineMeta[] {
  const { data } = useMeta();
  return data?.pipelines.filter((p) => p.objectKey === objectKey) ?? [];
}

export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: () => get<{ items: { id: string; full_name: string; email: string }[] }>('/api/v1/users'), staleTime: 300_000 });
}

export function useRecords(objectKey: string, params: Record<string, string | undefined>) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString();
  return useQuery({
    queryKey: ['records', objectKey, qs],
    queryFn: () => get<ListResponse<RecordDto>>(`/api/v1/records/${objectKey}${qs ? `?${qs}` : ''}`),
    placeholderData: (prev) => prev,
  });
}

export function stageLookup(meta: TenantMeta | undefined) {
  const m = new Map<string, { label: string; color: string | null; category: string; probability: number }>();
  for (const p of meta?.pipelines ?? []) for (const s of p.stages) m.set(s.id, s);
  return m;
}
