import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { FarmerAuthError, getFarmerMarketComparison, getFarmerProduce, getFarmerProfile, getFarmerSessionState, type FarmerMarketComparison, type FarmerProduce, type FarmerProfile } from '@/features/farmer-auth/client';
import { FarmerMarketResults } from '@/components/farmer-market-results';

type ProfileState = 'loading' | 'loaded' | 'error' | 'missing';

export default function FarmerHomeScreen() {
  const { t, language } = useLanguage();
  const params = useLocalSearchParams<{ produceAdded?: string; producePriceAdded?: string }>();
  const [profile, setProfile] = useState<FarmerProfile | null>(null);
  const [profileState, setProfileState] = useState<ProfileState>('loading');
  const [retryCount, setRetryCount] = useState(0);
  const [produce, setProduce] = useState<FarmerProduce[]>([]);
  const [produceState, setProduceState] = useState<ProfileState>('loading');
  const [marketResults, setMarketResults] = useState<Record<string, FarmerMarketComparison | null>>({});
  const [marketErrors, setMarketErrors] = useState<Record<string, 'unavailable' | 'notConfigured' | 'invalidKey' | 'rateLimited' | 'commodityUnrecognized'>>({});
  const [marketLoadingId, setMarketLoadingId] = useState<string | null>(null);
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

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getFarmerProduce(controller.signal)
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
    return () => { active = false; controller.abort(); };
  }, [retryCount, params.produceAdded, params.producePriceAdded]);

  const retryProfile = () => {
    setProfile(null);
    setProfileState('loading');
    setRetryCount((count) => count + 1);
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
        <Text style={styles.intro}>{t('farmer.intro')}</Text>
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
        <SectionHeading title={t('farmer.listings.title')} detail={t('farmer.listings.detail')} />
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
            {item.pricePerUnit != null ? <Text style={styles.producePrice}>{new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.pricePerUnit)} / {t(`produce.priceUnit.${item.unit}` as Parameters<typeof t>[0])}</Text> : <>
              <Text style={styles.pricePending}>{t('produce.status.awaitingPrice')}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/farmer-add-price', params: { produceId: item.id } })} style={styles.addPriceButton}><Text style={styles.addPriceButtonText}>{t('produce.addPrice')}</Text></Pressable>
            </>}
            {item.status === 'priced_unpublished' ? <Text style={styles.pricePending}>{t('produce.status.pricedUnpublished')}</Text> : null}
            <Pressable accessibilityRole="button" disabled={Boolean(marketLoadingId) || item.pricePerUnit == null} onPress={() => void compareMarketPrice(item)} style={[styles.marketCompareButton, (Boolean(marketLoadingId) || item.pricePerUnit == null) && styles.marketCompareDisabled]}>
              <Text style={styles.marketCompareText}>{marketLoadingId === item.id ? t('farmer.prices.comparing') : t('farmer.prices.compare')}</Text>
            </Pressable>
            {marketErrors[item.id] ? <View style={styles.marketResultPanel}>
              <Text accessibilityRole="alert" style={styles.marketMessage}>{t(marketErrors[item.id] === 'notConfigured' ? 'farmer.prices.notConfigured' : marketErrors[item.id] === 'invalidKey' ? 'farmer.prices.invalidKey' : marketErrors[item.id] === 'rateLimited' ? 'farmer.prices.rateLimited' : marketErrors[item.id] === 'commodityUnrecognized' ? 'farmer.prices.unavailableVegetable' : 'farmer.prices.providerError')}</Text>
              <Pressable accessibilityRole="button" disabled={Boolean(marketLoadingId)} onPress={() => void compareMarketPrice(item)} style={styles.profileRetry}><Text style={styles.profileRetryText}>{t('farmer.prices.retry')}</Text></Pressable>
            </View> : null}
            {marketResults[item.id] ? <FarmerMarketResults comparison={marketResults[item.id]!} t={t} language={language} /> : null}
          </View>
        </View>)}</View>}
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('farmer.requests.title')} detail={t('farmer.requests.detail')} />
        <EmptyState
          icon="💬"
          title={t('farmer.requests.emptyTitle')}
          message={t('farmer.requests.emptyMessage')}
          tone="blue"
        />
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('farmer.prices.title')} detail={t('farmer.prices.detail')} />
        <EmptyState icon="📊" title={t('farmer.prices.emptyTitle')} message={t('farmer.prices.emptyMessage')} tone="blue" />
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
});
