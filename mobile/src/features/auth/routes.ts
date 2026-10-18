export type AuthRole = 'farmer' | 'consumer';
export type AuthPage = 'login' | 'register' | 'forgot-password' | 'otp';

export const authRoutes: Record<AuthRole, Record<AuthPage, string>> = {
  farmer: {
    login: '/auth/farmer/login',
    register: '/auth/farmer/register',
    'forgot-password': '/auth/farmer/forgot-password',
    otp: '/auth/farmer/otp',
  },
  consumer: {
    login: '/auth/consumer/login',
    register: '/auth/consumer/register',
    'forgot-password': '/auth/consumer/forgot-password',
    otp: '/auth/consumer/otp',
  },
};
