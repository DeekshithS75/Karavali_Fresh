import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';
import { EmptyState, MarketColors, ScreenFrame, SectionHeading } from '@/components/marketplace-ui';
import { FarmerAuthError, decideFarmerProduceRequest, getFarmerNotifications, getFarmerRequests, markFarmerNotificationRead, retryFarmerRequestCall, startFarmerRequestCall, type FarmerProduceRequest } from '@/features/farmer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';
import { localizedProduceName } from '@/localization/produce-name';

function callStatusMessageKey(item: FarmerProduceRequest) {
  if (item.callFailureCode === 'provider_response_unknown') return 'consumer.callStatus.unknown';
  if (item.callFailureCode === 'provider_not_configured') return 'consumer.callStatus.providerNotConfigured';
  if (item.callFailureCode === 'participant_unavailable' || item.callFailureCode === 'participant_phone_invalid') return 'consumer.callStatus.participantUnavailable';
  if (item.callFailureCode === 'provider_rejected') return 'consumer.callStatus.providerRejected';
  if (item.callFailureCode === 'busy') return 'consumer.callStatus.busy';
  if (item.callFailureCode === 'no-answer') return 'consumer.callStatus.noAnswer';
  return 'consumer.callStatus.' + (item.callStatus ?? 'not_started');
}

export default function FarmerRequestsScreen() {
  const { t, language } = useLanguage();
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();
  const [items, setItems] = useState<FarmerProduceRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const callActionRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const [requests, notices] = await Promise.all([getFarmerRequests(), getFarmerNotifications()]);
      setItems([...requests.items].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      const justViewed = new Set(requests.items.map((item) => item.id));
      await Promise.all(notices.items.filter((notice) => notice.event === 'request_created' && notice.request && justViewed.has(notice.request.id) && !notice.readAt).map((notice) => markFarmerNotificationRead(notice.id)));
    } catch (reason) {
      if (reason instanceof FarmerAuthError && reason.code === 'unauthorized') router.replace('/auth/farmer');
      else setError(true);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void load(); });
    return () => subscription.remove();
  }, [load]);

  useEffect(() => {
    if (!items.some((item) => item.status === 'accepted' && (item.callStatus === 'queued' || item.callStatus === 'initiated'))) return undefined;
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      void getFarmerRequests().then((response) => {
        if (!active) return;
        const latest = new Map(response.items.map((item) => [item.id, item]));
        setItems((current) => current.map((item) => {
          const update = latest.get(item.id);
          return update ? { ...item, callStatus: update.callStatus, callConfirmed: update.callConfirmed, callFailureCode: update.callFailureCode } : item;
        }));
      }).catch((reason) => {
        if (active && reason instanceof FarmerAuthError && reason.code === 'unauthorized') router.replace('/auth/farmer');
      });
    }, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [items]);

  const decide = (item: FarmerProduceRequest, decision: 'accepted' | 'rejected') => {
    Alert.alert(t(decision === 'accepted' ? 'farmer.requests.acceptTitle' : 'farmer.requests.rejectTitle'), t('farmer.requests.confirm').replace('{name}', item.listingName), [
      { text: t('produce.deleteCancel'), style: 'cancel' },
      { text: t(decision === 'accepted' ? 'farmer.requests.accept' : 'farmer.requests.reject'), style: decision === 'rejected' ? 'destructive' : 'default', onPress: () => {
        setBusyId(item.id);
        void decideFarmerProduceRequest(item.id, decision).then(load).catch(() => setError(true)).finally(() => setBusyId(null));
      } },
    ]);
  };

  const callBuyer = (item: FarmerProduceRequest) => {
    if (callActionRef.current === item.id) return;
    callActionRef.current = item.id;
    setBusyId(item.id);
    setCallError(null);
    const retry = item.callStatus === 'failed' || Boolean(item.callFailureCode);
    void (retry ? retryFarmerRequestCall(item.id) : startFarmerRequestCall(item.id))
      .then(load)
      .catch((reason) => {
        if (reason instanceof FarmerAuthError && reason.code === 'unauthorized') router.replace('/auth/farmer');
        else setCallError(reason instanceof FarmerAuthError && ['network', 'apiUrlMissing', 'urlNotAllowed'].includes(reason.code)
          ? 'farmer.requests.callConnectionError' : 'farmer.requests.callError');
      })
      .finally(() => { callActionRef.current = null; setBusyId(null); });
  };

  return <FarmerDashboardGuard><ScreenFrame>
    <Pressable accessibilityRole="button" onPress={() => router.replace('/farmer')} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.welcome')}</Text></Pressable>
    <SectionHeading title={t('farmer.requests.title')} detail={t('farmer.requests.detail')} />
    {callError ? <Text accessibilityRole="alert" style={styles.error}>{t(callError as never)}</Text> : null}
    {loading && !items.length ? <View style={styles.center}><ActivityIndicator color={MarketColors.green} /></View> : error ? <View style={styles.card}><Text accessibilityRole="alert" style={styles.error}>{t('farmer.requests.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => void load()} style={styles.button}><Text style={styles.buttonText}>{t('produce.retry')}</Text></Pressable></View> : items.length === 0 ? <EmptyState icon="📨" title={t('farmer.requests.emptyTitle')} message={t('farmer.requests.emptyMessage')} /> : <View style={styles.list}>
      {items.map((item) => <View key={item.id} style={[styles.card, requestId === item.id && styles.selected]}>
        <Text style={styles.buyer}>{item.buyerName ?? t('farmer.requests.buyer')}</Text>
        <Text style={styles.name}>{localizedProduceName(item.listingName, item.listingNameTranslations, language)}</Text>
        <Text style={styles.body}>{t('farmer.requests.quantity').replace('{quantity}', String(item.requestedQuantity)).replace('{unit}', t(('produce.unit.' + item.unit) as never))}</Text>
        <Text style={styles.body}>{new Date(item.createdAt).toLocaleString()}</Text>
        <Text style={styles.status}>{t(('farmer.requests.status.' + item.status) as never)}</Text>
        {item.status === 'accepted' ? <>
          <Text style={styles.body}>{t(callStatusMessageKey(item) as never)}</Text>
          {item.callStatus === 'not_started' || item.callStatus === 'failed' || item.callStatus === 'unavailable' ? <Pressable accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => callBuyer(item)} style={styles.button}><Text style={styles.buttonText}>{t(busyId === item.id ? 'farmer.requests.working' : item.callStatus === 'failed' || Boolean(item.callFailureCode) ? 'farmer.requests.retryCall' : 'farmer.requests.callBuyer')}</Text></Pressable> : null}
        </> : null}
        {item.status === 'pending' ? <View style={styles.actions}>
          <Pressable accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => decide(item, 'accepted')} style={styles.button}><Text style={styles.buttonText}>{busyId === item.id ? t('farmer.requests.working') : t('farmer.requests.accept')}</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => decide(item, 'rejected')} style={styles.reject}><Text style={styles.rejectText}>{t('farmer.requests.reject')}</Text></Pressable>
        </View> : null}
      </View>)}
    </View>}
  </ScreenFrame></FarmerDashboardGuard>;
}

const styles = StyleSheet.create({
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 6 }, backText: { color: MarketColors.greenDark, fontWeight: '800' }, center: { minHeight: 240, alignItems: 'center', justifyContent: 'center' }, list: { gap: 10, marginTop: 14 }, card: { gap: 7, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: MarketColors.border, backgroundColor: MarketColors.card }, selected: { borderColor: MarketColors.green, borderWidth: 2 }, buyer: { color: MarketColors.text, fontSize: 14, fontWeight: '800' }, name: { color: MarketColors.text, fontSize: 16, fontWeight: '700' }, body: { color: MarketColors.muted, fontSize: 12, lineHeight: 18 }, status: { color: MarketColors.blue, fontSize: 12, fontWeight: '800' }, actions: { flexDirection: 'row', gap: 8, marginTop: 4 }, button: { minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 11, backgroundColor: MarketColors.green }, buttonText: { color: '#fff', fontWeight: '800' }, reject: { minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 11, backgroundColor: '#FDECEC' }, rejectText: { color: '#B42318', fontWeight: '800' }, error: { color: '#B42318' },
});
