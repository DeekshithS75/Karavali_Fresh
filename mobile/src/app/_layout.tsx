import { DefaultTheme, Stack, ThemeProvider, router, usePathname } from 'expo-router';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { BackHandler, Platform } from 'react-native';
import { routeForNotificationData } from '@/features/notification-navigation';
import { decideFarmerProduceRequest, FarmerAuthError } from '@/features/farmer-auth/client';

import { LanguageProvider } from '@/localization/LanguageProvider';

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export default function RootLayout() {
  const pathname = usePathname();
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const fallbackRoutes: Record<string, string> = {
      '/auth/farmer': '/',
      '/auth/farmer/register': '/auth/farmer',
      '/auth/farmer/login': '/auth/farmer',
      '/auth/farmer/verification': '/auth/farmer',
      '/auth/farmer/otp': '/auth/farmer/login',
      '/auth/consumer/login': '/',
      '/auth/consumer/register': '/auth/consumer/login',
      '/auth/consumer/forgot-password': '/auth/consumer/login',
      '/auth/consumer/otp': '/auth/consumer/login',
      '/consumer/produce/[produceId]': '/consumer',
      '/farmer-add-produce': '/farmer',
      '/farmer-add-price': '/farmer',
      '/farmer/requests': '/farmer',
      '/farmer/notifications': '/farmer',
      '/call': '/farmer/requests',
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pathname.startsWith('/auth/consumer/') || pathname === '/auth/farmer/otp') return false;
      if (router.canGoBack()) {
        router.back();
        return true;
      }
      const fallback = pathname.startsWith('/consumer/produce/') ? '/consumer' : fallbackRoutes[pathname];
      if (!fallback) return false;
      router.replace(fallback as never);
      return true;
    });
    return () => subscription.remove();
  }, [pathname]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const handleResponse = async (response: Notifications.NotificationResponse) => {
      const notification = response.notification;
      const data = notification.request.content.data;
      const target = routeForNotificationData(data);
      if (!target) return;
      const requestId = data && typeof data === 'object' && 'requestId' in data && typeof data.requestId === 'string' ? data.requestId : null;
      if (requestId && (response.actionIdentifier === 'accept' || response.actionIdentifier === 'decline')) {
        try {
          await decideFarmerProduceRequest(requestId, response.actionIdentifier === 'accept' ? 'accepted' : 'rejected');
        } catch (error) {
          // The request screen remains the authenticated fallback for expired sessions or stale actions.
          if (error instanceof FarmerAuthError && error.code === 'unauthorized') {
            router.replace('/auth/farmer');
            Notifications.clearLastNotificationResponse();
            return;
          }
        }
        router.replace({ pathname: '/farmer/requests', params: { requestId } });
      } else router.push(target as never);
      Notifications.clearLastNotificationResponse();
    };
    const initial = Notifications.getLastNotificationResponse();
    if (initial) void handleResponse(initial);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => { void handleResponse(response); });
    return () => subscription.remove();
  }, []);
  return (
    <LanguageProvider>
      <ThemeProvider value={DefaultTheme}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#F8F8F2' },
          }}
        />
      </ThemeProvider>
    </LanguageProvider>
  );
}
