export function isAppNavigation(url, origin) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && !/^\/(api|ws)(\/|$)/.test(parsed.pathname);
  } catch { return false; }
}

export function allowPermission(permission, requestingUrl, origin) {
  return permission === 'clipboard-sanitized-write' && isAppNavigation(requestingUrl, origin);
}
