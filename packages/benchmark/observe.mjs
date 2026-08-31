import { mkdir, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export function serializeStateFrame(frame, { seq = 0, observerDate = Date.now(), observerMonoNs = process.hrtime.bigint() } = {}) {
  const state = frame?.state ?? frame ?? {};
  const discord = state.apps?.discord ?? state.discord ?? frame?.discord ?? {};
  return {
    observerDate, observerMonoNs: String(observerMonoNs), observerSeq: seq,
    stateSeq: state.seq, appStateSeq: state.appStateSeq,
    recording: Boolean(frame?.recording ?? state.recording), source: frame?.source ?? state.source,
    degraded: Boolean(frame?.degraded ?? state.degraded), intent: frame?.intent ?? state.intent,
    confirmation: frame?.confirmation ?? state.confirmation,
    controlRelays: frame?.controlRelays ?? state.controlRelays,
    discord: { muted: discord.muted, online: discord.online, stateSeq: discord.stateSeq, clientMonoMs: discord.clientMonoMs },
  };
}

export async function prepareOutput(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600);
  await handle.chmod(0o600);
  return handle;
}

export function observe({ output, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!output) throw new Error('output path is required');
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket unavailable');
  let seq = 0; let closed = false; let handle;
  const socket = new WebSocketImpl('ws://127.0.0.1:8688');
  const finish = async () => { if (closed) return; closed = true; try { socket.close(); } catch {} await handle?.close(); };
  socket.addEventListener?.('message', async event => {
    try { handle ??= await prepareOutput(output); const frame = JSON.parse(String(event.data)); if (frame?.type !== 'state' && !frame?.state) return; await handle.write(`${JSON.stringify(serializeStateFrame(frame, { seq: seq++ }))}\n`); } catch {}
  });
  process.once('SIGINT', finish); process.once('SIGTERM', finish);
  return { socket, stop: finish };
}

export async function sourceReceipt() {
  const source = await readFile(new URL('./observe.mjs', import.meta.url));
  return { version: 'aqua-benchmark-observer.v2', sha256: createHash('sha256').update(source).digest('hex') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const receipt = await sourceReceipt();
    console.log(`observer-start version=${receipt.version} sha256=${receipt.sha256}`);
    observe({ output: process.argv[2] });
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
