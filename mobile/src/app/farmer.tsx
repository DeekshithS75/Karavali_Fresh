import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  BrandHeader,
  EmptyState,
  MarketColors,
  ScreenFrame,
  SectionHeading,
} from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';

export default function FarmerHomeScreen() {
  const { t } = useLanguage();

  return (
    <FarmerDashboardGuard>
    <ScreenFrame>
      <BrandHeader role="Farmer" />

      <View style={styles.welcomePanel}>
        <Text style={styles.eyebrow}>{t('farmer.eyebrow')}</Text>
        <Text style={styles.greeting}>{t('farmer.greeting')}</Text>
        <Text style={styles.intro}>{t('farmer.intro')}</Text>
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
