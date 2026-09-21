export const M3U_HTTP_HEADERS_PROPERTY = 'ynotv.http_headers';

export function getM3uHttpHeaders(properties?: Record<string, string> | string): Record<string, string> {
  if (!properties) return {};
  try {
    const props = typeof properties === 'string' ? JSON.parse(properties) : properties;
    const raw = props?.[M3U_HTTP_HEADERS_PROPERTY];
    const headers = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
    return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
      Boolean(name) && typeof value === 'string' && !/[\r\n]/.test(name) && !/[\r\n]/.test(value)
    )) as Record<string, string>;
  } catch {
    return {};
  }
}

export function splitM3uUserAgent(
  headers: Record<string, string>,
  fallback?: string,
): { userAgent?: string; headerFields: string } {
  let userAgent = fallback;
  const fields: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'user-agent') userAgent = value;
    else fields.push(`${name}: ${value}`);
  }
  return { userAgent, headerFields: fields.join(',') };
}
