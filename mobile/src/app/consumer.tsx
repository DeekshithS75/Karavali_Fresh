import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import * as Location from 'expo-location';

import { LanguageSelector } from '@/components/language-selector';
import { EmptyState, MarketColors, ScreenFrame, SectionHeading } from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import { registerAccountForPush } from '@/features/push-notifications';
import { ConsumerAuthError, getConsumerDemoListings, getConsumerListings, getConsumerNotifications, getConsumerPhotoHeaders, getConsumerProfile, getConsumerRequests, getConsumerSessionState, logoutConsumer, markConsumerNotificationRead, setConsumerPreferredLanguage, shareConsumerRequestPhone, subscribeToFarmer, unsubscribeFromFarmer, type ConsumerListing, type ConsumerListingQuery, type ConsumerNotification, type ConsumerProduceRequest } from '@/features/consumer-auth/client';
import { localizedProduceName } from '@/localization/produce-name';

type Sort = NonNullable<ConsumerListingQuery['sort']>;
const demoPhotoAssets = {
  tomatoes: require('../../assets/demo-produce/tomatoes.jpg'),
  brinjal: require('../../assets/demo-produce/brinjal.jpg'),
  cucumber: require('../../assets/demo-produce/cucumber.jpg'),
  okra: require('../../assets/demo-produce/okra.jpg'),
  carrots: require('../../assets/demo-produce/carrots.jpg'),
  beans: require('../../assets/demo-produce/beans.jpg'),
};

export default function ConsumerHomeScreen() {
  const { t, language, setLanguage } = useLanguage();
  const params = useLocalSearchParams<{ section?: string; requestId?: string }>();
  const [profileName, setProfileName] = useState('');
  const [pushStatus, setPushStatus] = useState<Awaited<ReturnType<typeof registerAccountForPush>> | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [distanceKm, setDistanceKm] = useState(25);
  const [location, setLocation] = useState<ConsumerListingQuery['location']>();
  const [locationError, setLocationError] = useState(false);
  const [items, setItems] = useState<ConsumerListing[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage] = useState(2);
  const [retry, setRetry] = useState(0);
  const [photoHeaders, setPhotoHeaders] = useState<Record<string, string>>({});
  const [failedPhotos, setFailedPhotos] = useState<string[]>([]);
  const [loggingOut, setLoggingOut] = useState(false);
  const [section, setSection] = useState<'browse' | 'requests' | 'notifications'>('browse');
  const activeSection = params.section === 'requests' || params.section === 'notifications' ? params.section : section;
  const selectedRequestId = params.requestId ?? null;
  const [myRequests, setMyRequests] = useState<ConsumerProduceRequest[]>([]);
  const [sharingPhoneId, setSharingPhoneId] = useState<string | null>(null);
  const [subscriptionBusyId, setSubscriptionBusyId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<ConsumerNotification[]>([]);
  const [notificationsPage, setNotificationsPage] = useState(1);
  const [notificationsHasMore, setNotificationsHasMore] = useState(false);
  const [loadingMoreNotifications, setLoadingMoreNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [requestLoadError, setRequestLoadError] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  const preferredLanguageLoaded = useRef(false);
  const languageHydrated = useRef(false);
  const lastSavedLanguage = useRef<'en' | 'kn' | 'tcy' | null>(null);

  const restoreSession = useCallback(async (isActive: () => boolean = () => true) => {
    const state = await getConsumerSessionState();
    if (!isActive()) return;
    if (state === 'missing' || state === 'invalid') { router.replace('/auth/consumer/login'); return; }
    if (state !== 'valid') { setSessionError(true); return; }
    try {
      const [profile, headers] = await Promise.all([getConsumerProfile(), getConsumerPhotoHeaders()]);
      if (!isActive()) return;
      setProfileName(profile.fullName);
      const preferredLanguage = profile.preferredLanguage ?? 'en';
      preferredLanguageLoaded.current = true;
      lastSavedLanguage.current = preferredLanguage;
      setLanguage(preferredLanguage);
      setPhotoHeaders(headers);
      setSessionError(false);
      setSessionReady(true);
    } catch (error) {
      if (!isActive()) return;
      if (error instanceof ConsumerAuthError && error.code === 'unauthorized') router.replace('/auth/consumer/login');
      else setSessionError(true);
    }
  }, [setLanguage]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => restoreSession(() => active)).catch(() => { if (active) setSessionError(true); });
    return () => { active = false; };
  }, [restoreSession]);

  useEffect(() => {
    if (!sessionReady || !preferredLanguageLoaded.current) return;
    if (!languageHydrated.current) {
      if (lastSavedLanguage.current !== language) return;
      languageHydrated.current = true;
      return;
    }
    if (lastSavedLanguage.current === language) return;
    lastSavedLanguage.current = language;
    void setConsumerPreferredLanguage(language).catch(() => undefined);
  }, [sessionReady, language]);

  useEffect(() => {
    if (sessionReady && languageHydrated.current) void registerAccountForPush('consumer', language).then((status) => setPushStatus(status));
  }, [sessionReady, language]);

  useEffect(() => {
    if (!sessionReady) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoadState('loading');
      void getConsumerListings({ search, sort, page: 1, limit: 12, ...(sort === 'nearby' && location ? { location, distanceKm } : {}) }, controller.signal)
        .then(async (result) => {
          const displayItems = result.items.length === 0 && sort === 'newest' ? await getConsumerDemoListings(search) : result.items;
          if (controller.signal.aborted) return;
          setItems(displayItems);
          setHasMore(result.hasMore);
          setNextPage(2);
          setLoadState('loaded');
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          if (error instanceof ConsumerAuthError && error.code === 'unauthorized') { router.replace('/auth/consumer/login'); return; }
          setLoadState('error');
        });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [sessionReady, search, sort, location, distanceKm, retry]);

  const enableNearby = async () => {
    setLocationError(false);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) { setLocationError(true); return; }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude, accuracy } = position.coords;
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || accuracy == null || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1_000) {
        setLocationError(true);
        return;
      }
      setLocation({ latitude, longitude, accuracyMeters: accuracy });
      setSort('nearby');
    } catch { setLocationError(true); }
  };

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await getConsumerListings({ search, sort, page: nextPage, limit: 12, ...(sort === 'nearby' && location ? { location, distanceKm } : {}) });
      setItems((current) => [...current, ...result.items]);
      setHasMore(result.hasMore);
      setNextPage((page) => page + 1);
    } catch (error) {
      if (error instanceof ConsumerAuthError && error.code === 'unauthorized') router.replace('/auth/consumer/login');
      else setLoadState('error');
    } finally { setLoadingMore(false); }
  };

  const signOut = async () => {
    setLoggingOut(true);
    try { await logoutConsumer(); } catch { /* Local credentials are cleared even when the server cannot be reached. */ }
    finally { router.replace('/'); }
  };

  const refreshBuyerActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const [requests, noticeList] = await Promise.all([getConsumerRequests(), getConsumerNotifications()]);
      setMyRequests(requests.items);
      setNotifications(noticeList.items);
      setNotificationsPage(1);
      setNotificationsHasMore(noticeList.hasMore);
      setUnreadCount(noticeList.unreadCount);
      setRequestLoadError(false);
    } catch (error) {
      if (error instanceof ConsumerAuthError && error.code === 'unauthorized') router.replace('/auth/consumer/login');
      else setRequestLoadError(true);
    } finally { setActivityLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => {
    if (sessionReady) void refreshBuyerActivity();
    return undefined;
  }, [sessionReady, refreshBuyerActivity]));

  const hasAcceptedRequests = myRequests.some((item) => item.status === 'accepted');
  useEffect(() => {
    if (activeSection !== 'requests' || !hasAcceptedRequests) return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      void getConsumerRequests().then((result) => setMyRequests(result.items)).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [activeSection, hasAcceptedRequests]);

  const markRead = async (id: string) => {
    try { await markConsumerNotificationRead(id); await refreshBuyerActivity(); }
    catch { setRequestLoadError(true); }
  };

  const sharePhone = async (item: ConsumerProduceRequest) => {
    setSharingPhoneId(item.id);
    try { await shareConsumerRequestPhone(item.id); await refreshBuyerActivity(); }
    catch { Alert.alert(t('contact.error' as never)); }
    finally { setSharingPhoneId(null); }
  };

  const dialSharedPhone = async (phone: string) => {
    try { await Linking.openURL(`tel:${phone}`); }
    catch { Alert.alert(t('contact.error' as never)); }
  };

  const toggleFarmerSubscription = async (item: ConsumerListing) => {
    if (subscriptionBusyId) return;
    setSubscriptionBusyId(item.farmerId);
    try {
      if (item.isFarmerFollowed) await unsubscribeFromFarmer(item.farmerId);
      else await subscribeToFarmer(item.farmerId);
      setItems((current) => current.map((listing) => listing.farmerId === item.farmerId ? { ...listing, isFarmerFollowed: !item.isFarmerFollowed } : listing));
    } catch (error) {
      if (error instanceof ConsumerAuthError && error.code === 'unauthorized') router.replace('/auth/consumer/login');
      else Alert.alert(t('consumer.subscriptionError'));
    } finally { setSubscriptionBusyId(null); }
  };

  const loadMoreNotifications = async () => {
    if (loadingMoreNotifications || !notificationsHasMore) return;
    setLoadingMoreNotifications(true);
    try {
      const nextPage = notificationsPage + 1;
      const result = await getConsumerNotifications(nextPage);
      setNotifications((current) => [...current, ...result.items]);
      setNotificationsPage(nextPage);
      setNotificationsHasMore(result.hasMore);
      setUnreadCount(result.unreadCount);
    } catch { setRequestLoadError(true); }
    finally { setLoadingMoreNotifications(false); }
  };

  if (!sessionReady) return <ScreenFrame><View style={styles.centerState}>{sessionError ? <><Text accessibilityRole="alert" style={styles.error}>{t('consumer.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => { setSessionError(false); void restoreSession().catch(() => setSessionError(true)); }} style={styles.secondary}><Text style={styles.secondaryText}>{t('consumer.retry')}</Text></Pressable></> : <ActivityIndicator color={MarketColors.green} />}</View></ScreenFrame>;

  return <ScreenFrame>
    <View style={styles.header}>
      <View style={styles.brandCopy}><Text style={styles.brandName}>{t('brand.name')}</Text><Text style={styles.role}>{t('consumer.headerSubtitle')}</Text></View>
      <View style={styles.headerActions}><LanguageSelector /><Pressable accessibilityRole="button" disabled={loggingOut} onPress={() => void signOut()} style={styles.logout}><Text style={styles.logoutText}>{t('consumer.logout')}</Text></Pressable></View>
    </View>
    <View style={styles.welcomePanel}>
      <Text style={styles.eyebrow}>{t('consumer.eyebrow')}</Text>
      <Text style={styles.greeting}>{t('consumer.greetingNamed').replace('{name}', profileName)}</Text>
      <Text style={styles.intro}>{t('consumer.intro')}</Text>
    </View>
    {pushStatus && pushStatus !== 'registered' && pushStatus !== 'unsupported_platform' ? <View accessibilityRole="alert" style={styles.pushNotice}><Text style={styles.help}>{t(pushStatus === 'denied' ? 'notifications.push.denied' : pushStatus === 'project_not_configured' ? 'notifications.push.projectMissing' : 'notifications.push.unavailable')}</Text></View> : null}
    <View style={styles.activityTabs}>
      <Pressable accessibilityRole="button" onPress={() => { router.setParams({ section: undefined, requestId: undefined }); setSection('browse'); }} style={[styles.activityTab, activeSection === 'browse' && styles.activityTabActive]}><Text style={[styles.activityTabText, activeSection === 'browse' && styles.activityTabTextActive]}>{t('consumer.browseTab')}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => { router.setParams({ section: undefined, requestId: undefined }); setSection('requests'); void refreshBuyerActivity(); }} style={[styles.activityTab, activeSection === 'requests' && styles.activityTabActive]}><Text style={[styles.activityTabText, activeSection === 'requests' && styles.activityTabTextActive]}>{t('consumer.requestsTab')}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => { router.setParams({ section: undefined, requestId: undefined }); setSection('notifications'); void refreshBuyerActivity(); }} style={[styles.activityTab, activeSection === 'notifications' && styles.activityTabActive]}><Text style={[styles.activityTabText, activeSection === 'notifications' && styles.activityTabTextActive]}>{t('consumer.notificationsTab')}{unreadCount ? ' (' + unreadCount + ')' : ''}</Text></Pressable>
    </View>
    {activeSection === 'browse' ? <>
    <View style={styles.searchBox}>
      <Text style={styles.searchIcon} accessibilityElementsHidden>⌕</Text>
      <TextInput accessibilityLabel={t('consumer.searchAccessibility')} placeholder={t('consumer.searchPlaceholder')} placeholderTextColor={MarketColors.muted} returnKeyType="search" value={search} onChangeText={setSearch} style={styles.searchInput} />
    </View>
    <View style={styles.sortSection}>
      <Text style={styles.sortLabel}>{t('consumer.sortTitle')}</Text>
      <View style={styles.sortButtons}>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: sort === 'newest' }} onPress={() => { setSort('newest'); setLocation(undefined); }} style={[styles.sortButton, sort === 'newest' && styles.sortSelected]}><Text style={[styles.sortText, sort === 'newest' && styles.sortTextSelected]}>{t('consumer.sortNewest')}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: sort === 'nearby' }} onPress={() => void enableNearby()} style={[styles.sortButton, sort === 'nearby' && styles.sortSelected]}><Text style={[styles.sortText, sort === 'nearby' && styles.sortTextSelected]}>{t('consumer.sortNearby')}</Text></Pressable>
      </View>
      {sort === 'nearby' ? <View style={styles.sortButtons}>{[5, 10, 25, 50, 100].map((distance) => <Pressable key={distance} accessibilityRole="button" accessibilityState={{ selected: distanceKm === distance }} onPress={() => setDistanceKm(distance)} style={[styles.sortButton, distanceKm === distance && styles.sortSelected]}><Text style={[styles.sortText, distanceKm === distance && styles.sortTextSelected]}>{distance} km</Text></Pressable>)}</View> : null}
      {locationError ? <Text accessibilityRole="alert" style={styles.help}>{t('consumer.locationUnavailable')}</Text> : null}
    </View>
    <View style={styles.section}>
      <SectionHeading title={t('consumer.listingsTitle')} detail={t('consumer.listingsDetail')} />
      {loadState === 'loading' ? <View style={styles.loading}><ActivityIndicator color={MarketColors.green} /><Text style={styles.help}>{t('consumer.loading')}</Text></View> : loadState === 'error' ? <View style={styles.errorPanel}><Text accessibilityRole="alert" style={styles.error}>{t('consumer.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => setRetry((value) => value + 1)} style={styles.secondary}><Text style={styles.secondaryText}>{t('consumer.retry')}</Text></Pressable></View> : items.length === 0 ? <EmptyState icon="🧺" title={t('consumer.emptyTitle')} message={t('consumer.emptyMessage')} /> : <View style={styles.listings}>
        {items.map((item) => {
          const displayName = localizedProduceName(item.name, item.nameTranslations, language);
          const photoKey = `${item.id}:0`;
          const photoSource = item.demoPhotoKey ? demoPhotoAssets[item.demoPhotoKey] : item.photoUrl ? { uri: item.photoUrl, headers: photoHeaders } : null;
          const postedAt = item.createdAt ? new Intl.DateTimeFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt)) : null;
          return <View key={item.id} style={styles.card}>
            <Pressable accessibilityRole="button" disabled={Boolean(item.isDemo)} onPress={() => router.push({ pathname: '/consumer/produce/[produceId]', params: { produceId: item.id } })}>
            {photoSource && !failedPhotos.includes(photoKey) ? <Image source={photoSource} contentFit="cover" onError={() => setFailedPhotos((current) => [...current, photoKey])} style={styles.photo} accessibilityLabel={`${t('consumer.photo')} ${displayName}`} /> : <View style={styles.photoPlaceholder}><Text style={styles.placeholderGlyph}>🥬</Text></View>}
            <View style={styles.cardInfo}>
              <Text style={styles.productName}>{displayName}</Text>
              {item.isDemo ? <Text style={styles.sampleBadge}>{t('consumer.sampleListing')}</Text> : null}
              <Text style={styles.price}>{t('consumer.askingPrice')}: {new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.pricePerUnit)} / {t(`produce.priceUnit.${item.priceUnit}` as never)}</Text>
              {item.marketComparison?.status === 'available' && item.marketComparison.items.some((quote) => quote.modalPrice !== null && !quote.stale) ? <><Text style={styles.marketPrice}>{t('consumer.marketPrice')}: {new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.marketComparison.items.find((quote) => quote.modalPrice !== null && !quote.stale)!.modalPrice!)} · {item.marketComparison.items.find((quote) => quote.modalPrice !== null && !quote.stale)!.sourceDate}</Text><Text style={styles.help}>{t('consumer.marketRegionalShort')}</Text></> : <Text style={styles.help}>{t('consumer.marketUnavailable')}</Text>}
              {item.farmerName ? <Text style={styles.locality}>{t('consumer.farmerName')}: {item.farmerName}</Text> : null}
              {postedAt ? <Text style={styles.locality}>{t('consumer.publishedAt')}: {postedAt}</Text> : null}
              {item.existingRequest ? <Text style={styles.requestSuccess}>{t('consumer.requestedLabel')} · {t(('consumer.requestStatus.' + item.existingRequest.status) as never)}</Text> : null}
              <Text style={styles.quantity}>{t('consumer.quantityAvailable').replace('{quantity}', String(item.quantity)).replace('{unit}', t(`produce.unit.${item.unit}` as never))}</Text>
              <Text style={styles.locality}>{t(item.distanceBand ? `consumer.distance.${item.distanceBand}` as never : 'consumer.locationNotShared')}</Text>
            </View>
            </Pressable>
            {item.farmerName && !item.isDemo ? <Pressable accessibilityRole="button" accessibilityState={{ selected: Boolean(item.isFarmerFollowed), disabled: subscriptionBusyId === item.farmerId }} disabled={subscriptionBusyId === item.farmerId} onPress={() => void toggleFarmerSubscription(item)} style={styles.subscriptionButton}><Text style={styles.secondaryText}>{subscriptionBusyId === item.farmerId ? t('consumer.subscriptionWorking') : t(item.isFarmerFollowed ? 'consumer.unsubscribeFarmer' : 'consumer.subscribeFarmer')}</Text></Pressable> : null}
          </View>;
        })}
        {hasMore ? <Pressable accessibilityRole="button" disabled={loadingMore} onPress={() => void loadMore()} style={styles.secondary}><Text style={styles.secondaryText}>{t(loadingMore ? 'consumer.loading' : 'consumer.loadMore')}</Text></Pressable> : null}
      </View>}
    </View>
    </> : activeSection === 'requests' ? <View style={styles.section}>
      <SectionHeading title={t('consumer.requestsTitle')} />
      {activityLoading ? <View style={styles.loading}><ActivityIndicator color={MarketColors.green} /><Text style={styles.help}>{t('consumer.loading')}</Text></View> : requestLoadError ? <View style={styles.errorPanel}><Text accessibilityRole="alert" style={styles.error}>{t('consumer.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => void refreshBuyerActivity()} style={styles.secondary}><Text style={styles.secondaryText}>{t('consumer.retry')}</Text></Pressable></View> : myRequests.length === 0 ? <EmptyState icon="🧺" title={t('consumer.requestsEmpty')} message={t('consumer.requestsEmptyDetail')} /> : <View style={styles.listings}>
        {myRequests.map((item) => <View key={item.id} style={[styles.activityCard, item.id === selectedRequestId && styles.selectedRequest]}>
          <Text style={styles.productName}>{localizedProduceName(item.listingName, item.listingNameTranslations, language)}</Text>
          <Text style={styles.quantity}>{t('consumer.requestedAmount').replace('{quantity}', String(item.requestedQuantity)).replace('{unit}', t(('produce.unit.' + item.unit) as never))}</Text>
          <Text style={styles.price}>{t(('consumer.requestStatus.' + item.status) as never)}</Text>
          <Text style={styles.quantity}>{t('consumer.priceAtRequest').replace('{price}', new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.pricePerUnit)).replace('{unit}', t(('produce.priceUnit.' + item.priceUnit) as never))}</Text>
          {item.status === 'accepted' ? <>
            <Text style={styles.help}>{t(('consumer.callStatus.' + (item.callStatus ?? 'unavailable')) as never)}</Text>
            {item.sharedPhone ? <Pressable accessibilityRole="button" onPress={() => void dialSharedPhone(item.sharedPhone!)} style={styles.detailsButton}><Text style={styles.detailsText}>{t('contact.call' as never)} {item.sharedPhone}</Text></Pressable> : null}
            <Pressable accessibilityRole="button" disabled={Boolean(sharingPhoneId) || item.ownPhoneShared} onPress={() => void sharePhone(item)} style={styles.detailsButton}><Text style={styles.detailsText}>{t(item.ownPhoneShared ? 'contact.shared' as never : sharingPhoneId === item.id ? 'farmer.requests.working' as never : 'contact.share' as never)}</Text></Pressable>
          </> : null}
        </View>)}
      </View>}
    </View> : <View style={styles.section}>
      <SectionHeading title={t('consumer.notificationsTitle')} detail={unreadCount ? t('consumer.unreadCount').replace('{count}', String(unreadCount)) : undefined} />
      {activityLoading ? <View style={styles.loading}><ActivityIndicator color={MarketColors.green} /><Text style={styles.help}>{t('consumer.loading')}</Text></View> : requestLoadError ? <View style={styles.errorPanel}><Text accessibilityRole="alert" style={styles.error}>{t('consumer.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => void refreshBuyerActivity()} style={styles.secondary}><Text style={styles.secondaryText}>{t('consumer.retry')}</Text></Pressable></View> : notifications.length === 0 ? <EmptyState icon="🔔" title={t('consumer.notificationsEmpty')} message={t('consumer.notificationsEmptyDetail')} /> : <View style={styles.listings}>
        {notifications.map((item) => <View key={item.id} style={styles.activityCard}>
          <Text style={styles.productName}>{t(('consumer.notification.' + item.event) as never)}</Text>
          {item.event === 'farmer_new_produce' ? <Text style={styles.quantity}>{item.produce?.farmerName} · {localizedProduceName(item.produce?.name ?? '', undefined, language)}</Text> : null}
          {item.request ? <><Text style={styles.quantity}>{localizedProduceName(item.request.listingName, item.request.listingNameTranslations, language)} · {t(('consumer.requestStatus.' + item.request.status) as never)}</Text><Pressable accessibilityRole="button" onPress={() => { router.setParams({ section: 'requests', requestId: item.request!.id }); setSection('requests'); void refreshBuyerActivity(); }} style={styles.detailsButton}><Text style={styles.detailsText}>{t('consumer.viewRequest')}</Text></Pressable></> : null}
          {item.request?.status === 'accepted' ? <Text style={styles.help}>{t(('consumer.callStatus.' + (item.request.callStatus ?? 'unavailable')) as never)}</Text> : null}
          {!item.readAt ? <Pressable accessibilityRole="button" onPress={() => void markRead(item.id)} style={styles.secondary}><Text style={styles.secondaryText}>{t('consumer.markRead')}</Text></Pressable> : null}
        </View>)}
        {notificationsHasMore ? <Pressable accessibilityRole="button" disabled={loadingMoreNotifications} onPress={() => void loadMoreNotifications()} style={styles.secondary}><Text style={styles.secondaryText}>{t(loadingMoreNotifications ? 'consumer.loading' : 'consumer.loadMore')}</Text></Pressable> : null}
      </View>}
    </View>}
  </ScreenFrame>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 }, brandCopy: { flexShrink: 1, paddingRight: 8 }, brandName: { color: MarketColors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.35 }, role: { color: MarketColors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.35, marginTop: 3 }, logout: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: MarketColors.greenSoft }, logoutText: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '800' },
  welcomePanel: { backgroundColor: MarketColors.greenSoft, borderRadius: 20, padding: 18, marginBottom: 14 }, eyebrow: { color: MarketColors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 }, greeting: { color: MarketColors.text, fontSize: 23, lineHeight: 29, fontWeight: '800', marginTop: 7 }, intro: { color: MarketColors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  searchBox: { minHeight: 50, flexDirection: 'row', alignItems: 'center', backgroundColor: MarketColors.card, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 14, paddingHorizontal: 13, marginBottom: 17 }, searchIcon: { color: MarketColors.green, fontSize: 24, lineHeight: 27, marginRight: 9 }, searchInput: { flex: 1, minHeight: 48, color: MarketColors.text, fontSize: 14 },
  sortSection: { gap: 8, marginBottom: 20 }, sortLabel: { color: MarketColors.text, fontWeight: '700', fontSize: 13 }, sortButtons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, sortButton: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: MarketColors.border, backgroundColor: MarketColors.card }, sortSelected: { borderColor: MarketColors.green, backgroundColor: MarketColors.greenSoft }, sortText: { color: MarketColors.text, fontSize: 12, fontWeight: '700' }, sortTextSelected: { color: MarketColors.greenDark },
  section: { marginBottom: 24 }, listings: { gap: 12 }, card: { gap: 10, padding: 12, borderRadius: 18, borderWidth: 1, borderColor: MarketColors.border, backgroundColor: MarketColors.card }, subscriptionButton: { minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: MarketColors.green, backgroundColor: MarketColors.greenSoft }, sampleBadge: { alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 5, overflow: 'hidden', borderRadius: 8, color: MarketColors.blue, backgroundColor: MarketColors.blueSoft, fontSize: 10, fontWeight: '700' }, photo: { width: '100%', height: 156, borderRadius: 13, backgroundColor: MarketColors.background }, photoPlaceholder: { width: '100%', height: 156, borderRadius: 13, backgroundColor: MarketColors.greenSoft, alignItems: 'center', justifyContent: 'center' }, placeholderGlyph: { fontSize: 38 }, cardInfo: { gap: 6 }, productName: { color: MarketColors.text, fontSize: 18, fontWeight: '800' }, quantity: { color: MarketColors.muted, fontSize: 12 }, price: { color: MarketColors.greenDark, fontSize: 15, fontWeight: '800' }, locality: { color: MarketColors.muted, fontSize: 11 }, marketPrice: { color: MarketColors.blue, fontSize: 11, lineHeight: 15, fontWeight: '700' }, detailsButton: { minHeight: 40, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }, detailsText: { color: MarketColors.greenDark, fontSize: 12, fontWeight: '800' }, requestSuccess: { color: MarketColors.greenDark, backgroundColor: MarketColors.greenSoft, borderRadius: 10, padding: 10, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  loading: { alignItems: 'center', gap: 8, paddingVertical: 28 }, help: { color: MarketColors.muted, fontSize: 12, lineHeight: 17 }, pushNotice: { backgroundColor: MarketColors.blueSoft, borderRadius: 12, padding: 11, marginBottom: 14 }, errorPanel: { gap: 8, backgroundColor: '#FFF4D6', borderRadius: 13, padding: 12 }, error: { color: '#B42318', fontSize: 13, lineHeight: 18 }, secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: MarketColors.green }, secondaryText: { color: MarketColors.greenDark, fontWeight: '800', fontSize: 13 }, centerState: { minHeight: 280, alignItems: 'center', justifyContent: 'center', gap: 12 },
  activityTabs: { flexDirection: 'row', gap: 6, marginBottom: 16 }, activityTab: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 12, borderWidth: 1, borderColor: MarketColors.border }, activityTabActive: { backgroundColor: MarketColors.greenSoft, borderColor: MarketColors.green }, activityTabText: { color: MarketColors.text, fontSize: 11, fontWeight: '700' }, activityTabTextActive: { color: MarketColors.greenDark }, activityCard: { gap: 7, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: MarketColors.border, backgroundColor: MarketColors.card }, selectedRequest: { borderColor: MarketColors.green, borderWidth: 2 }, requestForm: { gap: 8, marginTop: 8 }, requestInput: { minHeight: 44, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 10, paddingHorizontal: 10, color: MarketColors.text }, requestButton: { minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', backgroundColor: MarketColors.green, borderRadius: 10, paddingHorizontal: 12, marginTop: 5 }, requestButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 }, contactBox: { gap: 4, borderTopWidth: 1, borderColor: MarketColors.border, paddingTop: 9, marginTop: 5 },
});
