import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
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
