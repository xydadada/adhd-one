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

export function isTrustedControlUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'adhd-one:' && url.hostname === 'app' && url.port === '' && !url.username && !url.password
      && (url.pathname === '/' || url.pathname === '/index.html');
  } catch { return false; }
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
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/([?&](?:api_?key|token|key)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(["']?(?:api_?key|authorization|access_?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"';}]+/giu, '$1[REDACTED]')
    .replace(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;]+/gu, '[REDACTED_ENV]')
    .replace(/\\\\(?:\?\\)?(?:UNC[\\/])?[^\\\/\r\n"'<>|]+[\\\/][^\r\n"'<>|]*/gu, '[REDACTED_PATH]')
    .replace(/(?<!:)\/\/(?:\?\/)?(?:UNC\/)?[^\/\r\n"'<>|]+\/[^\r\n"'<>|]*/gu, '[REDACTED_PATH]')
    .replace(/file:\/\/[^\s"'<>|]+/giu, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]+/gu, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z]%3A(?:%5C|%2F)[^\s"'<>]+/giu, '[REDACTED_PATH]');
}

export function validateArchiveEntry(entry: string): boolean {
  const normalized = entry.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return false;
  if (normalized.split('/').some(part => part === '..' || part.includes(':'))) return false;
  return true;
}
