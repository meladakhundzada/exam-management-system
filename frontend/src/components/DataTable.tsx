import { useMemo, useState, ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  accessor?: (row: T) => string | number;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  pageSize?: number;
  searchableKeys?: Array<(row: T) => string>;
  filters?: Array<{ label: string; value: string; test: (row: T) => boolean }>;
  actions?: (row: T) => ReactNode;
}

export default function DataTable<T extends { id: string }>({
  columns,
  data,
  loading = false,
  emptyMessage = 'No records found.',
  pageSize = 10,
  searchableKeys = [],
  filters = [],
  actions,
}: DataTableProps<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let rows = data;
    const q = search.trim().toLowerCase();
    if (q && searchableKeys.length) {
      rows = rows.filter((row) => searchableKeys.some((fn) => fn(row).toLowerCase().includes(q)));
    }
    if (activeFilter !== 'all') {
      const f = filters.find((x) => x.value === activeFilter);
      if (f) rows = rows.filter(f.test);
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col?.accessor) {
        rows = [...rows].sort((a, b) => {
          const av = col.accessor!(a);
          const bv = col.accessor!(b);
          const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
          return sortDir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return rows;
  }, [data, search, searchableKeys, activeFilter, filters, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSort = (col: Column<T>) => {
    if (!col.sortable) return;
    if (sortKey === col.key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(col.key); setSortDir('asc'); }
  };

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-card dark:bg-slate-800 dark:ring-1 dark:ring-slate-700">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 dark:border-slate-700 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search…"
          aria-label="Search table"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 sm:max-w-xs"
        />
        {filters.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
            <button
              onClick={() => { setActiveFilter('all'); setPage(1); }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${activeFilter === 'all' ? 'bg-navy-600 text-white' : 'bg-slate-100 dark:bg-slate-700'}`}
            >
              All
            </button>
            {filters.map((f) => (
              <button
                key={f.value}
                onClick={() => { setActiveFilter(f.value); setPage(1); }}
                className={`rounded-full px-3 py-1 text-xs font-medium ${activeFilter === f.value ? 'bg-navy-600 text-white' : 'bg-slate-100 dark:bg-slate-700'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <span className="ml-auto text-xs text-slate-500">{filtered.length} record(s)</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              {columns.map((col) => (
                <th key={col.key} scope="col" className="px-4 py-3">
                  <button
                    type="button"
                    disabled={!col.sortable}
                    onClick={() => toggleSort(col)}
                    className={col.sortable ? 'hover:text-navy-600' : undefined}
                  >
                    {col.header}
                    {col.sortable && sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
              ))}
              {actions && <th scope="col" className="px-4 py-3">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={columns.length + 1} className="px-4 py-10 text-center text-slate-500">Loading…</td></tr>
            ) : pageRows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-4 py-10 text-center text-slate-500">{emptyMessage}</td></tr>
            ) : (
              pageRows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/50">
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      {col.render ? col.render(row) : col.accessor ? String(col.accessor(row)) : ''}
                    </td>
                  ))}
                  {actions && <td className="px-4 py-3">{actions(row)}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
        <span className="text-xs text-slate-500">
          Page {safePage} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Previous</button>
          <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
