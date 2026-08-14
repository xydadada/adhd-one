import path from 'node:path';

const EXTERNAL_HOSTS = new Set(['github.com', 'docs.github.com', 'api-docs.deepseek.com', 'platform.deepseek.com']);

export function parseLoopbackRuntimeUrl(candidate: string): URL | undefined {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' || url.username || url.password) return undefined;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return url;
  } catch { return undefined; }
}

export function isExactOrigin(candidate: string, trusted?: string): boolean {
  if (!trusted) return false;
  const parsed = parseLoopbackRuntimeUrl(candidate);
  const expected = parseLoopbackRuntimeUrl(trusted);
  return Boolean(parsed && expected && parsed.origin === expected.origin);
}

export function allowedExternalUrl(candidate: string): URL | undefined {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password && EXTERNAL_HOSTS.has(url.hostname) ? url : undefined;
  } catch { return undefined; }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function redactText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/([?&](?:api_?key|token|key)=)[^&\s]+/giu, '$1[REDACTED]');
}

export function validateArchiveEntry(entry: string): boolean {
  const normalized = entry.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return false;
  if (normalized.split('/').some(part => part === '..' || part.includes(':'))) return false;
  return true;
}
