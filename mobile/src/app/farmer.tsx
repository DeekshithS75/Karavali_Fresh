import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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
import { FarmerAuthError, getFarmerProduce, getFarmerProfile, getFarmerSessionState, type FarmerProduce, type FarmerProfile } from '@/features/farmer-auth/client';

type ProfileState = 'loading' | 'loaded' | 'error' | 'missing';

export default function FarmerHomeScreen() {
  const { t } = useLanguage();
  const params = useLocalSearchParams<{ produceAdded?: string }>();
  const [profile, setProfile] = useState<FarmerProfile | null>(null);
  const [profileState, setProfileState] = useState<ProfileState>('loading');
  const [retryCount, setRetryCount] = useState(0);
  const [produce, setProduce] = useState<FarmerProduce[]>([]);
  const [produceState, setProduceState] = useState<ProfileState>('loading');

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
  }, [retryCount]);

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

      {params.produceAdded === '1' ? <View accessibilityRole="alert" style={styles.savedNotice}><Text style={styles.savedNoticeText}>{t('produce.saved')}</Text></View> : null}

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
          {item.photos[0] ? <Image source={{ uri: item.photos[0].url, headers: item.photos[0].headers }} style={styles.produceImage} accessibilityLabel={`${t('produce.photoPreview')} ${item.name}`} /> : <View style={styles.produceImagePlaceholder}><Text style={styles.produceImageGlyph}>🌱</Text></View>}
          <View style={styles.produceInfo}>
            <Text style={styles.produceName}>{item.name}</Text>
            <Text style={styles.produceQuantity}>{t('produce.availableQuantity').replace('{quantity}', String(item.quantity)).replace('{unit}', t(`produce.unit.${item.unit}` as Parameters<typeof t>[0]))}</Text>
            <Text style={styles.pricePending}>{t('produce.priceNotAdded')}</Text>
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
        <EmptyState
          icon="📊"
          title={t('farmer.prices.emptyTitle')}
          message={t('farmer.prices.emptyMessage')}
          tone="blue"
        />
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
  section: { marginBottom: 22 }, savedNotice: { backgroundColor: MarketColors.greenSoft, borderRadius: 12, padding: 12, marginTop: -8, marginBottom: 18 }, savedNoticeText: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '700' }, listingMessage: { color: MarketColors.muted, fontSize: 13, lineHeight: 19 }, listingError: { borderRadius: 13, backgroundColor: '#FFF4D6', padding: 12 }, listingStack: { gap: 10 }, produceCard: { flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: MarketColors.border, padding: 10 }, produceImage: { width: 76, height: 76, borderRadius: 12, backgroundColor: MarketColors.background }, produceImagePlaceholder: { width: 76, height: 76, borderRadius: 12, backgroundColor: MarketColors.greenSoft, alignItems: 'center', justifyContent: 'center' }, produceImageGlyph: { fontSize: 24 }, produceInfo: { flex: 1, gap: 4 }, produceName: { color: MarketColors.text, fontSize: 15, fontWeight: '800' }, produceQuantity: { color: MarketColors.muted, fontSize: 12 }, pricePending: { color: MarketColors.blue, fontSize: 11, fontWeight: '700' },
});
