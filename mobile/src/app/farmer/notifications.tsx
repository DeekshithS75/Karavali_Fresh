import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';
import { MarketColors, ScreenFrame, SectionHeading } from '@/components/marketplace-ui';
import { FarmerAuthError, getFarmerNotifications, markFarmerNotificationRead, type FarmerNotification } from '@/features/farmer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';
import { localizedProduceName } from '@/localization/produce-name';

export default function FarmerNotificationsScreen() {
  const { t, language } = useLanguage();
  const { notificationId } = useLocalSearchParams<{ notificationId?: string }>();
  const [items, setItems] = useState<FarmerNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async (nextPage = 1, append = false) => {
    setLoading(true); setError(false);
    try {
      const result = await getFarmerNotifications(nextPage);
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setUnread(result.unreadCount); setPage(nextPage); setHasMore(result.hasMore);
      if (notificationId && nextPage === 1) {
        const selected = result.items.find((item) => item.id === notificationId);
        if (selected && !selected.readAt) await markFarmerNotificationRead(selected.id);
      }
    } catch (reason) {
      if (reason instanceof FarmerAuthError && reason.code === 'unauthorized') router.replace('/auth/farmer');
      else setError(true);
    } finally { setLoading(false); }
  }, [notificationId]);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  const markRead = async (item: FarmerNotification) => {
    setBusyId(item.id);
    try { await markFarmerNotificationRead(item.id); setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry)); setUnread((value) => Math.max(0, value - 1)); }
    catch { setError(true); }
    finally { setBusyId(null); }
  };

  return <FarmerDashboardGuard><ScreenFrame>
    <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.welcome')}</Text></Pressable>
    <SectionHeading title={t('farmer.notifications.title')} detail={`${unread} ${t('farmer.notifications.unread')}`} />
    {loading && items.length === 0 ? <View style={styles.center}><ActivityIndicator color={MarketColors.green} /></View> : error ? <View style={styles.panel}><Text accessibilityRole="alert" style={styles.error}>{t('farmer.requests.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => void load()} style={styles.button}><Text style={styles.buttonText}>{t('produce.retry')}</Text></Pressable></View> : items.length === 0 ? <Text style={styles.help}>{t('farmer.notifications.empty')}</Text> : <View style={styles.list}>
      {items.map((item) => <View key={item.id} style={[styles.card, item.id === notificationId && styles.selected, !item.readAt && styles.unread]}>
        <Text style={styles.title}>{t(('farmer.notifications.event.' + item.event) as never)}{!item.readAt ? ' · ●' : ''}</Text>
        {item.request ? <>
          <Text style={styles.name}>{item.request.buyerName ?? t('farmer.requests.buyer')}</Text>
          <Text style={styles.help}>{localizedProduceName(item.request.listingName, item.request.listingNameTranslations, language)} · {t('farmer.requests.quantity').replace('{quantity}', String(item.request.requestedQuantity)).replace('{unit}', t(('produce.unit.' + item.request.unit) as never))}</Text>
          <Text style={styles.help}>{t(('farmer.requests.status.' + item.request.status) as never)} · {new Date(item.createdAt).toLocaleString()}</Text>
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/farmer/requests', params: { requestId: item.request!.id } })} style={styles.read}><Text style={styles.readText}>{t('farmer.requests.title')}</Text></Pressable>
        </> : null}
        {!item.readAt ? <Pressable accessibilityRole="button" disabled={busyId === item.id} onPress={() => void markRead(item)} style={styles.read}><Text style={styles.readText}>{t('farmer.notifications.markRead')}</Text></Pressable> : null}
      </View>)}
      {hasMore ? <Pressable accessibilityRole="button" disabled={loading} onPress={() => void load(page + 1, true)} style={styles.button}><Text style={styles.buttonText}>{t(loading ? 'produce.loading' : 'consumer.loadMore')}</Text></Pressable> : null}
    </View>}
  </ScreenFrame></FarmerDashboardGuard>;
}

const styles = StyleSheet.create({
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 6 }, backText: { color: MarketColors.greenDark, fontWeight: '800' }, center: { minHeight: 220, justifyContent: 'center', alignItems: 'center' }, panel: { gap: 10, padding: 14, backgroundColor: MarketColors.card, borderRadius: 14 }, list: { gap: 10, marginTop: 16 }, card: { gap: 7, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: MarketColors.border, backgroundColor: MarketColors.card }, selected: { borderColor: MarketColors.green, borderWidth: 2 }, unread: { backgroundColor: '#F0F8F2' }, title: { color: MarketColors.text, fontSize: 14, fontWeight: '800' }, name: { color: MarketColors.text, fontSize: 14, fontWeight: '700' }, help: { color: MarketColors.muted, fontSize: 12, lineHeight: 18 }, error: { color: '#B42318' }, actions: { flexDirection: 'row', gap: 8, marginTop: 4 }, button: { minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 11, backgroundColor: MarketColors.green }, buttonText: { color: '#fff', fontWeight: '800' }, reject: { minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 11, backgroundColor: '#FDECEC' }, rejectText: { color: '#B42318', fontWeight: '800' }, read: { minHeight: 40, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 5 }, readText: { color: MarketColors.greenDark, fontWeight: '800' },
});
