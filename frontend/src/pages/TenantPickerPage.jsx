import { Building2 } from 'lucide-react';
import { PageHeader } from '../components/ui/primitives';
import { useAuth } from '../auth/AuthContext';
import { tenantHome } from '../tenant';

/** Shown when the URL names no tenant and this account may enter several. */
export default function TenantPickerPage() {
  const { tenants } = useAuth();
  return (
    <div className="animate-fade-in">
      <PageHeader icon={Building2} title="Choose a tenant" description="Each tenant has its own data. Pick the one to work in." />
      {tenants.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted">This account is not a member of any tenant yet. Ask a global admin to add it.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tenants.map((t) => (
            <a key={t.id} href={tenantHome(t.id)} className="panel p-4 hover:border-brand/40 transition-colors block">
              <p className="text-sm font-semibold text-ink">{t.name}</p>
              <p className="text-[11px] text-ink-faint font-mono">{t.id}</p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
