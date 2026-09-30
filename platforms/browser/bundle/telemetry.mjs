// SPDX-License-Identifier: GPL-3.0-or-later
// Crash reports to Sentry, only when the page carries a DSN
// (tools/browser/bundle.py --sentry-dsn); otherwise nothing loads or is sent.
//
// Reported: engine aborts (titled by their PANIC location so the same crash
// groups, with the wasm stack), uncaught errors and rejections, and files the
// pak lacks. Each report carries the recent log as breadcrumbs and tags for
// the browser, OS, GPU, CPU, memory, screen and exact build. No IP address or
// other personal data (sendDefaultPii: false), no tracing, no replays.

let sentry = null;
let started = null;
const reported = new Set();

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content?.trim() || '';

/** The DSN the page was built with, or '' when reporting is off. */
export const telemetryDsn = () => meta('sentry-dsn');

async function environment() {
  const env = {
    cores: navigator.hardwareConcurrency ?? null,
    memory_gb: navigator.deviceMemory ?? null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    isolated: String(globalThis.crossOriginIsolated),
    webgpu: String(!!navigator.gpu),
  };
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues(['platformVersion', 'architecture', 'model']);
    if (hints) Object.assign(env, { os_version: hints.platformVersion, arch: hints.architecture, model: hints.model || null });
  } catch {}
  try {
    const adapter = await navigator.gpu?.requestAdapter({ featureLevel: 'compatibility', powerPreference: 'high-performance' });
    const info = adapter?.info;
    if (info) {
      Object.assign(env, {
        gpu_vendor: info.vendor || null,
        gpu_architecture: info.architecture || null,
        gpu_device: info.device || null,
        gpu_description: info.description || null,
      });
    }
  } catch {}
  return env;
}

/** Start Sentry if the page has a DSN. Safe to call more than once. */
export function startTelemetry() {
  const dsn = telemetryDsn();
  if (!dsn) return Promise.resolve(false);
  started ??= (async () => {
    sentry = await import('./vendor/sentry.mjs');
    sentry.init({
      dsn,
      release: meta('melee-release') || 'dev',
      environment: /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'development' : 'production',
      sendDefaultPii: false,
      tracesSampleRate: 0,
      // No release-health sessions: they are not needed for crash reports and
      // ask Sentry to infer the visitor's IP address.
      integrations: (defaults) => defaults.filter((integration) => integration.name !== 'BrowserSession'),
      maxBreadcrumbs: 100,
      // The engine abort is reported once, by reportEngineAbort, with its
      // PANIC line; the RuntimeError the runtime rethrows is the same crash.
      ignoreErrors: [/^Aborted\(/, /RuntimeError: Aborted\(/],
    });
    const env = await environment();
    sentry.setContext('device', env);
    sentry.setTags({
      gpu_vendor: env.gpu_vendor ?? 'unknown',
      gpu_architecture: env.gpu_architecture ?? 'unknown',
      cores: String(env.cores ?? 'unknown'),
      isolated: env.isolated,
    });
    return true;
  })().catch((error) => {
    console.warn('telemetry: Sentry unavailable:', error);
    return false;
  });
  return started;
}

/** Extra facts about this session, attached to every report from now on. */
export function setSessionContext(name, value) {
  started?.then((ok) => ok && sentry.setContext(name, value));
}

/**
 * The engine stopped. `panic` is its last PANIC line (the assert location),
 * which titles and groups the report; the stack is taken here, inside the
 * abort, so it holds the wasm frames.
 */
export async function reportEngineAbort(reason, panic, extra = {}) {
  // Before any await: only here is the stack still the abort's own.
  const error = new Error(panic || `Engine stopped: ${reason}`);
  error.name = panic ? 'EnginePanic' : 'EngineAbort';
  if (!(await started)) return;
  sentry.captureException(error, { level: 'fatal', tags: { kind: 'engine-abort' }, extra: { reason: String(reason), ...extra } });
  await sentry.flush(3000);
}

/** The page could not start or stopped (no WebGPU, a failed download...). */
export async function reportPageError(error) {
  if (!(await started)) return;
  sentry.captureException(error instanceof Error ? error : Error(String(error)), { tags: { kind: 'page' } });
}

/** A notable engine log line (a file missing from the pak), once per text. */
export async function reportEngineWarning(line) {
  if (reported.has(line) || !(await started)) return;
  reported.add(line);
  sentry.captureMessage(line, { level: 'warning', tags: { kind: 'engine-warning' } });
}
