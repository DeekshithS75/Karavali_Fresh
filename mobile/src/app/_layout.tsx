import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { routeForNotificationData } from '@/features/notification-navigation';

import { LanguageProvider } from '@/localization/LanguageProvider';

export default function RootLayout() {
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const redirect = (notification: Notifications.Notification) => {
      const target = routeForNotificationData(notification.request.content.data);
      if (!target) return;
      router.push(target as never);
      Notifications.clearLastNotificationResponse();
    };
    const initial = Notifications.getLastNotificationResponse();
    if (initial?.notification) redirect(initial.notification);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => redirect(response.notification));
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
