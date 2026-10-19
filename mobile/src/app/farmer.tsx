import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';

import {
  BrandHeader,
  EmptyState,
  MarketColors,
  ScreenFrame,
  SectionHeading,
} from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';
import { FarmerAuthError, decideFarmerProduceRequest, deleteFarmerProduce, getFarmerMarketComparison, getFarmerNotifications, getFarmerProduce, getFarmerProfile, getFarmerRequests, getFarmerSessionState, type FarmerMarketComparison, type FarmerProduce, type FarmerProduceRequest, type FarmerProfile } from '@/features/farmer-auth/client';
import { FarmerMarketResults } from '@/components/farmer-market-results';
import { registerAccountForPush } from '@/features/push-notifications';

type ProfileState = 'loading' | 'loaded' | 'error' | 'missing';

export default function FarmerHomeScreen() {
  const { t, language } = useLanguage();
  const params = useLocalSearchParams<{ produceAdded?: string; producePriceAdded?: string }>();
  const [profile, setProfile] = useState<FarmerProfile | null>(null);
  const [profileState, setProfileState] = useState<ProfileState>('loading');
  const [retryCount, setRetryCount] = useState(0);
  const produceRefreshKey = `${retryCount}:${params.produceAdded ?? ''}:${params.producePriceAdded ?? ''}`;
  const [produce, setProduce] = useState<FarmerProduce[]>([]);
  const [produceState, setProduceState] = useState<ProfileState>('loading');
  const [marketResults, setMarketResults] = useState<Record<string, FarmerMarketComparison | null>>({});
  const [marketErrors, setMarketErrors] = useState<Record<string, 'unavailable' | 'notConfigured' | 'invalidKey' | 'rateLimited' | 'commodityUnrecognized'>>({});
  const [marketLoadingId, setMarketLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
  const [incomingRequests, setIncomingRequests] = useState<FarmerProduceRequest[]>([]);
  const [recentPendingRequests, setRecentPendingRequests] = useState<FarmerProduceRequest[]>([]);
  const [farmerUnreadCount, setFarmerUnreadCount] = useState(0);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const [requestSectionError, setRequestSectionError] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const marketController = useRef<AbortController | null>(null);

  useEffect(() => () => marketController.current?.abort(), []);

  const compareMarketPrice = async (item: FarmerProduce) => {
    if (marketLoadingId) return;
    const controller = new AbortController();
    marketController.current?.abort();
    marketController.current = controller;
    setMarketLoadingId(item.id);
    setMarketErrors((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const result = await getFarmerMarketComparison(item.id, controller.signal);
      setMarketResults((current) => ({ ...current, [item.id]: result }));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof FarmerAuthError && error.code === 'unauthorized') {
        const sessionState = await getFarmerSessionState();
        if (sessionState === 'missing' || sessionState === 'invalid') { router.replace('/auth/farmer'); return; }
      }
      const marketError = error instanceof FarmerAuthError && error.code === 'marketPriceNotConfigured' ? 'notConfigured'
        : error instanceof FarmerAuthError && error.code === 'marketPriceInvalidKey' ? 'invalidKey'
          : error instanceof FarmerAuthError && error.code === 'marketPriceRateLimited' ? 'rateLimited'
            : error instanceof FarmerAuthError && error.code === 'marketCommodityUnrecognized' ? 'commodityUnrecognized' : 'unavailable';
      setMarketErrors((current) => ({ ...current, [item.id]: marketError }));
    } finally {
      if (marketController.current === controller) {
        marketController.current = null;
        setMarketLoadingId(null);
      }
    }
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    getFarmerProfile(controller.signal)
      .then((value) => {
        if (!active) return;
        setProfile(value);
        setProfileState('loaded');
        void registerAccountForPush('farmer');
      })
      .catch(async (error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof FarmerAuthError && error.code === 'unauthorized') {
          const sessionState = await getFarmerSessionState();
          if (!active) return;
          if (sessionState === 'missing' || sessionState === 'invalid') {
            router.replace('/auth/farmer');
            return;
          }
        }
        if (!active) return;
        setProfileState(error instanceof FarmerAuthError && error.code === 'profileNotFound' ? 'missing' : 'error');
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [retryCount]);

  useFocusEffect(useCallback(() => {
    let active = true;
    const controller = new AbortController();
    setProduceState('loading');
    getFarmerProduce(controller.signal, produceRefreshKey)
      .then((items) => { if (active) { setProduce(items); setProduceState('loaded'); } })
      .catch(async (error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof FarmerAuthError && error.code === 'unauthorized') {
          const sessionState = await getFarmerSessionState();
          if (!active) return;
          if (sessionState === 'missing' || sessionState === 'invalid') { router.replace('/auth/farmer'); return; }
        }
        if (active) setProduceState('error');
      });
    setRequestsLoading(true);
    Promise.all([getFarmerRequests(), getFarmerNotifications()])
      .then(([requests, notices]) => {
        if (active) {
          const now = Date.now();
          setIncomingRequests(requests.items);
          setRecentPendingRequests(requests.items.filter((item) => item.status === 'pending' && now - new Date(item.createdAt).getTime() <= 2 * 60 * 60 * 1000));
          setFarmerUnreadCount(notices.unreadCount);
          setRequestSectionError(false);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof FarmerAuthError && error.code === 'unauthorized') router.replace('/auth/farmer');
        else setRequestSectionError(true);
      })
      .finally(() => { if (active) setRequestsLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [produceRefreshKey]));

  const retryProfile = () => {
    setProfile(null);
    setProfileState('loading');
    setRetryCount((count) => count + 1);
  };

  const deleteListing = (item: FarmerProduce) => {
    if (deletingId) return;
    Alert.alert(t('produce.deleteConfirmTitle'), t('produce.deleteConfirmMessage').replace('{name}', item.name), [
      { text: t('produce.deleteCancel'), style: 'cancel' },
      { text: t('produce.delete'), style: 'destructive', onPress: () => { void (async () => {
        setDeletingId(item.id);
        setDeleteErrorId(null);
        try {
          await deleteFarmerProduce(item.id);
          setProduce((current) => current.filter((entry) => entry.id !== item.id));
          Alert.alert(t('produce.deleteSuccessTitle'), t('produce.deleteSuccessMessage'));
        } catch (error) {
          if (error instanceof FarmerAuthError && error.code === 'unauthorized') { router.replace('/auth/farmer'); return; }
          setDeleteErrorId(item.id);
        } finally { setDeletingId(null); }
      })(); } },
    ]);
  };

  const decideRequest = (item: FarmerProduceRequest, decision: 'accepted' | 'rejected') => {
    const title = decision === 'accepted' ? t('farmer.requests.acceptTitle') : t('farmer.requests.rejectTitle');
    Alert.alert(title, t('farmer.requests.confirm').replace('{name}', item.listingName), [
      { text: t('produce.deleteCancel'), style: 'cancel' },
      { text: decision === 'accepted' ? t('farmer.requests.accept') : t('farmer.requests.reject'), style: decision === 'rejected' ? 'destructive' : 'default', onPress: () => { void (async () => {
        setRequestActionId(item.id);
        try {
          await decideFarmerProduceRequest(item.id, decision);
          await Promise.all([getFarmerRequests().then((result) => setIncomingRequests(result.items)), getFarmerNotifications().then((result) => setFarmerUnreadCount(result.unreadCount))]);
          setRetryCount((count) => count + 1);
          Alert.alert(t('farmer.requests.updatedTitle'), t('farmer.requests.updatedMessage'));
        } catch (error) {
          if (error instanceof FarmerAuthError && error.code === 'unauthorized') { router.replace('/auth/farmer'); return; }
          Alert.alert(t('farmer.requests.errorTitle'), error instanceof FarmerAuthError && error.serverError === 'produce_request_insufficient_quantity' ? t('farmer.requests.insufficient') : t('farmer.requests.error'));
        } finally { setRequestActionId(null); }
      })(); } },
    ]);
  };

  return (
    <FarmerDashboardGuard>
    <ScreenFrame>
      <BrandHeader role="Farmer" />

      <View style={styles.welcomePanel}>
        <Text style={styles.eyebrow}>{t('farmer.eyebrow')}</Text>
        <Text style={styles.greeting} accessibilityRole={profileState === 'loading' ? 'text' : undefined}>
          {profile ? t('farmer.greetingNamed').replace('{name}', profile.fullName) : profileState === 'loading' ? t('farmer.profileLoading') : t('farmer.greeting')}
        </Text>
        {profileState === 'error' || profileState === 'missing' ? <View style={styles.profileError}>
          <Text accessibilityRole="alert" style={styles.profileErrorText}>
            {t(profileState === 'missing' ? 'farmer.profileMissing' : 'farmer.profileLoadError')}
          </Text>
          <Pressable accessibilityRole="button" onPress={retryProfile} style={styles.profileRetry}>
            <Text style={styles.profileRetryText}>{t('farmer.profileRetry')}</Text>
          </Pressable>
        </View> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('accessibility.addProduce')}
          onPress={() => router.push('/farmer-add-produce')}
          style={styles.addButton}>
          <Text style={styles.addIcon}>＋</Text>
          <Text style={styles.addButtonText}>{t('farmer.addProduce')}</Text>
        </Pressable>
      </View>

      {params.produceAdded === '1' ? <View accessibilityRole="alert" style={styles.savedNotice}><Text style={styles.savedNoticeText}>{t('produce.saved')}</Text></View> : params.producePriceAdded === '1' ? <View accessibilityRole="alert" style={styles.savedNotice}><Text style={styles.savedNoticeText}>{t('produce.priceSaved')}</Text></View> : null}

      <View style={styles.section}>
        <SectionHeading title={t('farmer.listings.title')} />
        {produceState === 'loading' ? <Text style={styles.listingMessage}>{t('produce.loading')}</Text> : produceState === 'error' ? <View style={styles.listingError}>
          <Text accessibilityRole="alert" style={styles.listingMessage}>{t('produce.loadError')}</Text>
          <Pressable accessibilityRole="button" onPress={() => { setProduceState('loading'); setRetryCount((count) => count + 1); }} style={styles.profileRetry}><Text style={styles.profileRetryText}>{t('produce.retry')}</Text></Pressable>
        </View> : produce.length === 0 ? <EmptyState
          icon="🌾"
          title={t('farmer.listings.emptyTitle')}
          message={t('farmer.listings.emptyMessage')}
        /> : <View style={styles.listingStack}>{produce.map((item) => <View key={item.id} style={styles.produceCard}>
          <View style={styles.producePhotos}>{item.photos.length ? item.photos.map((photo, index) => <Image key={`${photo.url}-${index}`} source={{ uri: photo.url, headers: photo.headers }} style={styles.produceImage} accessibilityLabel={`${t('produce.photoPreview')} ${item.name} ${index + 1}`} />) : <View style={styles.produceImagePlaceholder}><Text style={styles.produceImageGlyph}>🌱</Text></View>}</View>
          <View style={styles.produceInfo}>
            <Text style={styles.produceName}>{item.nameTranslations?.[language]?.trim() || item.name}</Text>
            <Text style={styles.produceQuantity}>{t('produce.availableQuantity').replace('{quantity}', String(item.quantity)).replace('{unit}', t(`produce.unit.${item.unit}` as Parameters<typeof t>[0]))}</Text>
            {item.pricePerUnit != null ? <Text style={styles.producePrice}>{new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.pricePerUnit)} / {t(`produce.priceUnit.${item.priceUnit ?? item.unit}` as Parameters<typeof t>[0])}</Text> : <>
              <Text style={styles.pricePending}>{t('produce.status.awaitingPrice')}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/farmer-add-price', params: { produceId: item.id } })} style={styles.addPriceButton}><Text style={styles.addPriceButtonText}>{t('produce.addPrice')}</Text></Pressable>
            </>}
            {item.status === 'priced_unpublished' ? <Text style={styles.pricePending}>{t('produce.status.pricedUnpublished')}</Text> : null}
            {item.pricePerUnit != null ? <Pressable accessibilityRole="button" disabled={Boolean(marketLoadingId)} onPress={() => void compareMarketPrice(item)} style={[styles.marketCompareButton, Boolean(marketLoadingId) && styles.marketCompareDisabled]}>
              <Text style={styles.marketCompareText}>{marketLoadingId === item.id ? t('farmer.prices.comparing') : t('farmer.prices.compare')}</Text>
            </Pressable> : null}
            {deleteErrorId === item.id ? <Text accessibilityRole="alert" style={styles.deleteError}>{t('produce.deleteError')}</Text> : null}
            <Pressable accessibilityRole="button" disabled={Boolean(deletingId)} onPress={() => deleteListing(item)} style={[styles.deleteButton, Boolean(deletingId) && styles.marketCompareDisabled]}>
              <Text style={styles.deleteButtonText}>{deletingId === item.id ? t('produce.deleteWorking') : t('produce.delete')}</Text>
            </Pressable>
            {marketErrors[item.id] ? <View style={styles.marketResultPanel}>
              <Text accessibilityRole="alert" style={styles.marketMessage}>{t('farmer.prices.quoteError')}</Text>
              <Pressable accessibilityRole="button" disabled={Boolean(marketLoadingId)} onPress={() => void compareMarketPrice(item)} style={styles.profileRetry}><Text style={styles.profileRetryText}>{t('farmer.prices.retry')}</Text></Pressable>
            </View> : null}
            {marketResults[item.id] ? <FarmerMarketResults comparison={marketResults[item.id]!} t={t} language={language} /> : null}
          </View>
        </View>)}</View>}
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('farmer.requests.title')} detail={t('farmer.requests.detail')} />
        {requestsLoading ? <Text style={styles.listingMessage}>{t('produce.loading')}</Text> : requestSectionError ? <View style={styles.listingError}><Text accessibilityRole="alert" style={styles.listingMessage}>{t('farmer.requests.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => setRetryCount((count) => count + 1)} style={styles.profileRetry}><Text style={styles.profileRetryText}>{t('produce.retry')}</Text></Pressable></View> : incomingRequests.length === 0 ? <EmptyState icon="📨" title={t('farmer.requests.emptyTitle')} message={t('farmer.requests.emptyMessage')} /> : <View style={styles.listingStack}>
          {incomingRequests.map((item) => <View key={item.id} style={styles.requestCard}>
            {item.status === 'pending' ? <Text style={styles.produceName}>{item.buyerName ?? t('farmer.requests.buyer')}</Text> : null}
            <Text style={styles.produceName}>{item.listingName}</Text>
            <Text style={styles.produceQuantity}>{t('farmer.requests.quantity').replace('{quantity}', String(item.requestedQuantity)).replace('{unit}', t(('produce.unit.' + item.unit) as never))}</Text>
            <Text style={styles.pricePending}>{t(('farmer.requests.status.' + item.status) as never)}</Text>
            {item.status === 'pending' ? <View style={styles.requestActions}>
              <Pressable accessibilityRole="button" disabled={Boolean(requestActionId)} onPress={() => decideRequest(item, 'accepted')} style={styles.addPriceButton}><Text style={styles.addPriceButtonText}>{requestActionId === item.id ? t('farmer.requests.working') : t('farmer.requests.accept')}</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={Boolean(requestActionId)} onPress={() => decideRequest(item, 'rejected')} style={styles.rejectButton}><Text style={styles.rejectButtonText}>{t('farmer.requests.reject')}</Text></Pressable>
            </View> : null}
          </View>)}
        </View>}
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('farmer.notifications.title')} detail={String(farmerUnreadCount) + ' ' + t('farmer.notifications.unread')} />
        {requestsLoading ? <Text style={styles.listingMessage}>{t('produce.loading')}</Text> : requestSectionError ? <Text accessibilityRole="alert" style={styles.listingMessage}>{t('farmer.requests.loadError')}</Text> : recentPendingRequests.length === 0 ? <Text style={styles.listingMessage}>{t('farmer.notifications.empty')}</Text> : <View style={styles.listingStack}>
          {recentPendingRequests.map((item) => <View key={item.id} style={styles.requestCard}>
            <Text style={styles.produceName}>{item.buyerName ?? t('farmer.requests.buyer')}</Text>
            <Text style={styles.produceQuantity}>{item.listingName} · {t('farmer.requests.quantity').replace('{quantity}', String(item.requestedQuantity)).replace('{unit}', t(('produce.unit.' + item.unit) as never))}</Text>
            <Text style={styles.produceQuantity}>{new Date(item.createdAt).toLocaleTimeString()}</Text>
          </View>)}
        </View>}
        <Pressable accessibilityRole="button" onPress={() => router.push('/farmer/notifications')} style={styles.profileRetry}><Text style={styles.profileRetryText}>{t('farmer.notifications.viewAll')}</Text></Pressable>
      </View>

    </ScreenFrame>
    </FarmerDashboardGuard>
  );
}

const styles = StyleSheet.create({
  welcomePanel: {
    backgroundColor: MarketColors.greenSoft,
    borderRadius: 22,
    padding: 20,
    marginBottom: 24,
  },
  eyebrow: { color: MarketColors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  greeting: { color: MarketColors.text, fontSize: 25, lineHeight: 31, fontWeight: '800', marginTop: 8 },
  intro: { color: MarketColors.muted, fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 540 },
  profileError: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: '#FFF4D6', gap: 8 },
  profileErrorText: { color: '#684B12', fontSize: 12, lineHeight: 18 },
  profileRetry: { minHeight: 40, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 12 },
  profileRetryText: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '800' },
  addButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: MarketColors.green,
    borderRadius: 13,
    paddingHorizontal: 15,
    marginTop: 17,
  },
  addIcon: { color: '#FFFFFF', fontSize: 20, marginRight: 7 },
  addButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  section: { marginBottom: 22 }, savedNotice: { backgroundColor: MarketColors.greenSoft, borderRadius: 12, padding: 12, marginTop: -8, marginBottom: 18 }, savedNoticeText: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '700' }, listingMessage: { color: MarketColors.muted, fontSize: 13, lineHeight: 19 }, listingError: { borderRadius: 13, backgroundColor: '#FFF4D6', padding: 12 }, listingStack: { gap: 10 }, produceCard: { gap: 10, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: MarketColors.border, padding: 10 }, producePhotos: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, produceImage: { width: 64, height: 64, borderRadius: 10, backgroundColor: MarketColors.background }, produceImagePlaceholder: { width: 64, height: 64, borderRadius: 10, backgroundColor: MarketColors.greenSoft, alignItems: 'center', justifyContent: 'center' }, produceImageGlyph: { fontSize: 24 }, produceInfo: { gap: 4 }, produceName: { color: MarketColors.text, fontSize: 15, fontWeight: '800' }, produceQuantity: { color: MarketColors.muted, fontSize: 12 }, producePrice: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '800' }, pricePending: { color: MarketColors.blue, fontSize: 11, fontWeight: '700' }, addPriceButton: { minHeight: 36, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 9, backgroundColor: MarketColors.greenSoft }, addPriceButtonText: { color: MarketColors.greenDark, fontSize: 12, fontWeight: '800' },
  marketCompareButton: { minHeight: 38, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: MarketColors.blueSoft }, marketCompareDisabled: { opacity: 0.5 }, marketCompareText: { color: MarketColors.blue, fontSize: 12, fontWeight: '800' }, marketResultPanel: { backgroundColor: MarketColors.blueSoft, borderRadius: 12, padding: 10, gap: 6, marginTop: 4 }, marketRow: { borderTopWidth: 1, borderTopColor: MarketColors.border, paddingTop: 8, marginTop: 4, gap: 3 }, marketName: { color: MarketColors.text, fontSize: 13, fontWeight: '800' }, marketMessage: { color: MarketColors.muted, fontSize: 12, lineHeight: 18 }, marketAttribution: { color: MarketColors.muted, fontSize: 10, lineHeight: 15, marginTop: 3 },
  requestCard: { gap: 6, padding: 12, backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: MarketColors.border }, requestActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }, rejectButton: { minHeight: 36, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 9, backgroundColor: '#FDECEC' }, rejectButtonText: { color: '#B42318', fontSize: 12, fontWeight: '800' },
  deleteButton: { minHeight: 42, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#FDECEC' }, deleteButtonText: { color: '#B42318', fontSize: 13, fontWeight: '800' }, deleteError: { color: '#B42318', fontSize: 12, lineHeight: 18 },
});
