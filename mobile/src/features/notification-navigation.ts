export function routeForNotificationData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('url' in data) || typeof data.url !== 'string') return null;
  const path = data.url;
  if (path.startsWith('/call?')) return path;
  if (path.startsWith('/farmer/requests?') || path === '/farmer/requests' || path.startsWith('/farmer/notifications?') || path.startsWith('/farmer?') || path.startsWith('/consumer?')) return path;
  return null;
}
