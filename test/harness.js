import net from 'node:net';
import dgram from 'node:dgram';

const tests = [];
export function test(name, fn) {
  tests.push({ name, fn });
}

export async function run(label) {
  let failed = 0;
  console.log(`\n${label}`);
  for (const t of tests.splice(0)) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.name}\n    ${err.stack?.split('\n').slice(0, 4).join('\n    ')}`);
    }
  }
  return failed;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(cond, timeout = 3000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = cond();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`timeout after ${timeout} ms`);
}
