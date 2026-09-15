import { useParams } from 'react-router-dom';
import PrivacyInspectorPage from './PrivacyInspectorPage';

// Host route /ai/privacy/:platform. Installed plugin packs cannot bundle the
// Privacy Inspector (it depends on host components), so their nav links here
// instead; the page itself is the same per-platform audit trail the built-in
// platform modules mount at /<id>/privacy.
export default function PrivacyInspectorRoute() {
  const { platform } = useParams();
  return <PrivacyInspectorPage platform={platform} />;
}
