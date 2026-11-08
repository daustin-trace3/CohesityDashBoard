import { Fingerprint } from 'lucide-react';
import { Badge } from '../ui/primitives';

// Small chip naming the identity provider behind a user or group row.
// `providers` is the list from GET /idp/providers; when the row's provider id
// is unknown (older backend, deleted provider) the chip reads "SSO".
export default function ProviderBadge({ providerId, providers, fallback = 'SSO' }) {
  const match = providerId != null && Array.isArray(providers)
    ? providers.find((p) => p.id === providerId)
    : null;
  return (
    <Badge tone="brand">
      <Fingerprint size={10} className="mr-1" />
      {match ? match.name : fallback}
    </Badge>
  );
}
