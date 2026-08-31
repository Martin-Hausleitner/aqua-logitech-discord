const trial = (i, extra = {}) => ({
  hook: { hookSeq: i * 2 + 1, hookMonoNs: String(2_000_000_000 + i * 2_000_000), recording: true },
  confirmation: { source: 'coreaudio', recording: true, stateSeq: i },
  discord: { actual: true, freshMs: 20, cacheOverride: false }, stateSeq: i,
  restore: true, degraded: false, disconnected: false, timeout: false, ...extra
});
export const acceptedManifest = () => ({ schema: 'aqua.run-manifest.v1', sourceIdentity: 'aqua-source@fixture', buildIdentity: 'benchmark-build@fixture', route: 'g4-aquabutton1-button1.sh-8690', baseline: 'unmuted', physicalLatencyExcluded: true, trials: Array.from({ length: 25 }, (_, i) => trial(i)) });
export const rejectedManifest = () => ({ ...acceptedManifest(), route: 'wrong-route', physicalLatencyExcluded: false, trials: acceptedManifest().trials.map((t, i) => i === 7 ? { ...t, discord: { actual: false, freshMs: 5001, cacheOverride: true } } : t) });
