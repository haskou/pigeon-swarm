const { spawn } = require('node:child_process');

function supervise(commands) {
  const children = [];
  let stopping = false;
  let result = 0;
  let deadline;

  const signal = (child, name) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const finish = () => {
    if (!stopping || children.some(child => child.exitCode === null && child.signalCode === null && child.pid)) return;
    for (const child of children) signal(child, 'SIGKILL');
    clearTimeout(deadline);
    process.exit(result);
  };
  const stop = code => {
    if (stopping) return;
    stopping = true;
    result = code;
    for (const child of children) signal(child, 'SIGTERM');
    deadline = setTimeout(() => {
      for (const child of children) signal(child, 'SIGKILL');
      process.exit(result || 1);
    }, 10000);
    finish();
  };
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  for (const [name, [command, ...args]] of Object.entries(commands)) {
    const env = { ...process.env };
    if (name === 'turn') {
      delete env.CALLS_TURN_SHARED_SECRET;
      env.CALLS_TURN_SECRET_FILE = '/run/pigeon/turn-shared-secret';
    }
    const child = spawn(command, args, { env, detached: true, stdio: 'inherit' });
    children.push(child);
    child.on('error', () => {
      console.error(`${name} could not start`);
      stop(1);
    });
    child.on('exit', () => {
      if (!stopping) {
        console.error(`${name} stopped unexpectedly`);
        stop(1);
      }
      finish();
    });
  }
}

module.exports = { supervise };

if (require.main === module) {
  supervise({
    backend: process.argv.slice(2),
    turn: ['/bin/sh', '/opt/pigeon/run-turn-from-runtime-config.sh',
      '--log-file=stdout', '--fingerprint', '--use-auth-secret', '--realm=pigeon-swarm',
      '--pidfile=/run/pigeon-turn/turnserver.pid', '--no-dtls', '--no-multicast-peers', '--stale-nonce=600'],
  });
}
