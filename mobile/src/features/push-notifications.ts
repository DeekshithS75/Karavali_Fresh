import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { registerConsumerPushToken } from '@/features/consumer-auth/client';
import { registerFarmerPushToken } from '@/features/farmer-auth/client';

export async function registerAccountForPush(role: 'farmer' | 'consumer') {
  if (Platform.OS === 'web') return 'unsupported_platform' as const;
  if (!Device.isDevice) return 'unavailable' as const;
  try {
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('requests', {
      name: 'Produce requests', importance: AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250],
    });
    const current = await Notifications.getPermissionsAsync();
    const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
    if (permission.status !== 'granted') return 'denied' as const;
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return 'project_not_configured' as const;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (role === 'farmer') await registerFarmerPushToken(token);
    else await registerConsumerPushToken(token);
    return 'registered' as const;
  } catch { return 'unavailable' as const; }
}
