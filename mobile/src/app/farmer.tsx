import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import {
  BrandHeader,
  EmptyState,
  MarketColors,
  ScreenFrame,
  SectionHeading,
} from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';
import { FarmerAuthError, getFarmerProfile, getFarmerSessionState, type FarmerProfile } from '@/features/farmer-auth/client';

type ProfileState = 'loading' | 'loaded' | 'error' | 'missing';

export default function FarmerHomeScreen() {
  const { t } = useLanguage();
  const [profile, setProfile] = useState<FarmerProfile | null>(null);
  const [profileState, setProfileState] = useState<ProfileState>('loading');
  const [retryCount, setRetryCount] = useState(0);

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
          accessibilityState={{ disabled: true }}
          disabled
          style={styles.addButton}>
          <Text style={styles.addIcon}>＋</Text>
          <Text style={styles.addButtonText}>{t('farmer.addProduce')}</Text>
          <Text style={styles.comingSoon}>{t('farmer.comingSoon')}</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('farmer.listings.title')} detail={t('farmer.listings.detail')} />
        <EmptyState
          icon="🌾"
          title={t('farmer.listings.emptyTitle')}
          message={t('farmer.listings.emptyMessage')}
        />
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
    opacity: 0.82,
  },
  addIcon: { color: '#FFFFFF', fontSize: 20, marginRight: 7 },
  addButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  comingSoon: { color: '#E5F2E8', fontSize: 10, fontWeight: '600', marginLeft: 10 },
  section: { marginBottom: 22 },
});
