export type FarmerSessionState = 'valid' | 'missing' | 'invalid' | 'unavailable' | 'configuration-error';
export type FarmerAccountRoute = 'login' | 'register' | 'verification' | 'error';

export async function restoreFarmerSession<T extends { accessToken: string }>(
  read: () => Promise<T | null>,
  validate: (accessToken: string) => Promise<boolean>,
  clear: () => Promise<void>,
  isUnauthorized: (error: unknown) => boolean,
  isConfigurationError: (error: unknown) => boolean = () => false,
): Promise<FarmerSessionState> {
  let tokens: T | null;
  try { tokens = await read(); }
  catch { return 'unavailable'; }
  if (!tokens) return 'missing';
  try {
    if (await validate(tokens.accessToken)) return 'valid';
    await clear();
    return 'invalid';
  } catch (error) {
    if (isUnauthorized(error)) {
      try { await clear(); return 'invalid'; }
      catch { return 'unavailable'; }
    }
    if (isConfigurationError(error)) return 'configuration-error';
    return 'unavailable';
  }
}

export async function revokeFarmerSession<T extends { accessToken: string }>(
  read: () => Promise<T | null>,
  revoke: (accessToken: string) => Promise<void>,
  clear: () => Promise<void>,
) {
  const tokens = await read();
  if (tokens) await revoke(tokens.accessToken);
  await clear();
}

export function routeForFarmerAccount(status: 'registered' | 'pending' | 'new' | string): FarmerAccountRoute {
  if (status === 'registered') return 'login';
  if (status === 'pending') return 'verification';
  if (status === 'new') return 'register';
  return 'error';
}

export function routeForFarmerSession(state: FarmerSessionState): 'dashboard' | 'authentication' | 'retry' {
  if (state === 'valid') return 'dashboard';
  if (state === 'missing' || state === 'invalid') return 'authentication';
  return 'retry';
}
