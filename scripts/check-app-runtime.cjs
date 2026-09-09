const { spawnSync } = require('node:child_process');

async function check() {
  const port = process.env.API_PORT || process.env.PORT || '8080';
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) return false;
  if (process.env.PIGEON_TURN_MODE === 'external') return true;
  return spawnSync('/opt/pigeon/check-turn-runtime.sh', { timeout: 2000, stdio: 'ignore' }).status === 0;
}

check().then(ok => process.exit(ok ? 0 : 1)).catch(() => process.exit(1));
