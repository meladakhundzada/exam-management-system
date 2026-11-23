interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: string;
  accent?: 'blue' | 'green' | 'amber' | 'red' | 'violet';
  trend?: { label: string; positive: boolean };
}

const ACCENTS: Record<NonNullable<StatCardProps['accent']>, string> = {
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
};

export default function StatCard({ title, value, subtitle, icon, accent = 'blue', trend }: StatCardProps) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800 dark:shadow-none dark:ring-1 dark:ring-slate-700">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{title}</p>
          <p className="mt-1 text-3xl font-bold text-navy-900 dark:text-white">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
        </div>
        <span aria-hidden="true" className={`flex h-11 w-11 items-center justify-center rounded-lg text-xl ${ACCENTS[accent]}`}>
          {icon}
        </span>
      </div>
      {(subtitle || trend) && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {trend && (
            <span className={trend.positive ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>
              {trend.label}{' '}
            </span>
          )}
          {subtitle}
        </p>
      )}
    </div>
  );
}
