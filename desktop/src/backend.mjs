import http from 'node:http';

export function isVisualizerHealth(value) {
  return value?.ok === true && typeof value.tmuxRunning === 'boolean'
    && typeof value.version === 'string' && /^\d+\.\d+\.\d+/.test(value.version)
    && typeof value.instanceId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instanceId);
}

// Only a refused connection means a backend may safely be started. A timeout,
// unexpected response, or a different service must never be mistaken for absence.
export function probeBackend(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL('/api/health', url), (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) req.destroy(new Error('Backend health response is too large'));
      });
      res.on('error', reject);
      res.on('end', () => {
        let health;
        try { health = JSON.parse(body); } catch { /* rejected below */ }
        if (res.statusCode === 200 && isVisualizerHealth(health)) resolve(health);
        else reject(new Error(`Port at ${url} is occupied by an unrecognized service. The desktop app will not replace or stop it.`));
      });
    });
    // A wall-clock deadline also catches a service dripping a partial response.
    const timer = setTimeout(() => req.destroy(new Error(`Backend at ${url} did not respond in time`)), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => error.code === 'ECONNREFUSED' ? resolve(null) : reject(error));
  });
}

export async function acquireBackend({ url, spawn, probe = probeBackend, timeoutMs = 20000, intervalMs = 200, onUnexpectedExit = () => {} }) {
  if (await probe(url)) return { url, owned: false, close() {} };
  const child = await spawn();
  let closed = false;
  let exited = false;
  let ready = false;
  let exitCode;
  let closing;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    if (ready && !closed) onUnexpectedExit(code);
  });
  const close = () => {
    if (closed) return closing;
    closed = true;
    closing = exited ? Promise.resolve() : new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    return closing;
  };
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Desktop backend exited before it was ready (code ${exitCode})`);
      const health = await probe(url);
      if (exited) throw new Error(`Desktop backend exited before it was ready (code ${exitCode})`);
      if (health) {
        ready = true;
        return { url, owned: true, close };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Desktop backend did not become ready within 20 seconds');
  } catch (error) {
    await close();
    throw error;
  }
}
