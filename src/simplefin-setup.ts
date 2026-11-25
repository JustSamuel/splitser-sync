import { randomBytes } from 'node:crypto';
import { accessUrl, setupToken } from './simplefin.ts';

const publicUrl = process.argv[2];
if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
  console.error('Usage: pnpm simplefin:setup https://your-splitser-sync-host');
  process.exit(1);
}
const secret = randomBytes(32).toString('base64url');
const claim = randomBytes(16).toString('base64url');
console.log(`Set these on the splitser-sync service, then redeploy:

SIMPLEFIN_PUBLIC_URL=${publicUrl}
SIMPLEFIN_ACCESS_SECRET=${secret}
SIMPLEFIN_CLAIM_TOKEN=${claim}

Paste this setup token into Actual (Settings > Bank Sync > SimpleFIN):

${setupToken(publicUrl, claim)}

Afterwards remove SIMPLEFIN_CLAIM_TOKEN and redeploy so it cannot be claimed again.`);
