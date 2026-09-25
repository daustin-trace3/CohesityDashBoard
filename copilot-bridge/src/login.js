import { startDeviceFlow, pollForToken, saveGithubToken, getCopilotToken } from './auth.js';

async function main() {
  console.log('\nStarting GitHub device login for Copilot access...\n');
  const flow = await startDeviceFlow();

  console.log('  1. Open this URL in your browser:');
  console.log(`       ${flow.verification_uri}`);
  console.log('  2. Enter this one-time code:');
  console.log(`       ${flow.user_code}\n`);
  console.log('Waiting for you to authorize (this window will update automatically)...');

  const githubToken = await pollForToken(flow.device_code, flow.interval);
  saveGithubToken(githubToken);
  console.log('\nGitHub authorization saved. Verifying Copilot entitlement...');

  await getCopilotToken(true);
  console.log('Copilot access confirmed. You can now run `npm start`.\n');
}

main().catch((e) => {
  console.error('\nLogin failed:', e.message, '\n');
  process.exit(1);
});
