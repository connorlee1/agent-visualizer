import { providerClasses } from '@shared/providers';
import type { Provider } from '@shared/types';

export function ProviderBadge({ provider }: { provider: Provider }) {
  const cls = providerClasses[provider];
  return (
    <span className={`rounded border px-1.5 py-px font-body text-[10px] ${cls}`}>{provider}</span>
  );
}
