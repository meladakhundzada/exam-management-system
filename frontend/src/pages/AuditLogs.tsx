import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import { reportsApi, AuditLogItem, apiErrorMessage } from '../services/api';

type AuditRow = Omit<AuditLogItem, 'id'> & { id: string };

const PAGE_SIZE = 50;

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = async (p = 1) => {
    setLoading(true);
    try {
      const { data } = await reportsApi.auditLogs(p, PAGE_SIZE);
      setLogs((data.data as unknown as AuditLogItem[]).map((a) => ({ ...a, id: String(a.id) })));
      // The backend returns { data, pagination: { page, limit, total } }
      // on this route; the axios wrapper types it as ApiResponse, so read
      // pagination off the raw response body.
      const pagination = (data as unknown as { pagination?: { total?: number } }).pagination;
      setTotal(pagination?.total ?? 0);
      setPage(p);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(1); }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns: Column<AuditRow>[] = [
    { key: 'created', header: 'When', sortable: true, accessor: (r) => String(r.created_at).slice(0, 19).replace('T', ' ') },
    { key: 'user', header: 'User', sortable: true, accessor: (r) => r.user_name ?? `User ${r.user_id ?? '—'}` },
    { key: 'action', header: 'Action', sortable: true, accessor: (r) => r.action },
    { key: 'entity', header: 'Entity', accessor: (r) => `${r.entity_type ?? '—'}${r.entity_id ? ` #${r.entity_id}` : ''}` },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <p className="text-sm text-slate-500">
          Super Admin only — every recorded sign-in, creation, update, deletion, approval and publication,
          newest first. {total > 0 ? `${total} entr${total === 1 ? 'y' : 'ies'} in total.` : ''}
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <DataTable<AuditRow>
        columns={columns}
        data={logs}
        loading={loading}
        emptyMessage="No audit entries yet."
        searchableKeys={[(r) => r.action, (r) => r.user_name ?? '', (r) => r.entity_type ?? '']}
      />

      <div className="flex items-center justify-between text-sm">
        <span className="text-xs text-slate-500">Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1 || loading} onClick={() => load(page - 1)} className="rounded-lg border bg-white px-3 py-1 disabled:opacity-40 dark:bg-slate-800">Previous</button>
          <button disabled={page >= totalPages || loading} onClick={() => load(page + 1)} className="rounded-lg border bg-white px-3 py-1 disabled:opacity-40 dark:bg-slate-800">Next</button>
        </div>
      </div>
    </div>
  );
}
