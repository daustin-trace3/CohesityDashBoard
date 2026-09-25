import { ensureApiKey, regenerateApiKey } from './apiKey.js';

const cmd = (process.argv[2] || 'show').toLowerCase();

if (cmd === 'regenerate' || cmd === 'new') {
  console.log('New API key:', regenerateApiKey());
  console.log('(The previous key is now invalid.)');
} else {
  console.log('API key:', ensureApiKey());
}
