import { StyleSheet, Text, View } from 'react-native';
import { MarketColors } from './marketplace-ui';
import type { FarmerMarketComparison } from '@/features/farmer-auth/client';
import type { TranslationKey } from '@/localization/types';

type Props = { comparison: FarmerMarketComparison; t: (key: TranslationKey) => string; language: 'en' | 'kn' | 'tcy' };

export function FarmerMarketResults({ comparison, t, language }: Props) {
  const item = comparison.items[0];
  if (comparison.status === 'missing' || !item) {
    return <View style={styles.panel}><Text style={styles.message}>{t('farmer.prices.unavailableVegetable')}</Text></View>;
  }
  if (!item.unitCompatible || item.modalPrice === null || !item.priceUnit) {
    return <View style={styles.panel}><Text style={styles.message}>{t('farmer.prices.unitUnavailable')}</Text></View>;
  }
  const currency = new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  }).format(item.modalPrice);
  const unit = item.priceUnit.split('/')[1] ?? 'kg';
  const date = new Intl.DateTimeFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { dateStyle: 'medium' }).format(new Date(`${item.sourceDate}T00:00:00`));

  return <View style={styles.panel}>
    <Text style={styles.price}>{t('farmer.prices.simpleMandiPrice').replace('{price}', currency).replace('{unit}', t(`produce.priceUnit.${unit}` as TranslationKey))}</Text>
    {item.fallbackLevel === 'other_karnataka' ? <Text style={styles.secondary}>{t('farmer.prices.regionalReference')}</Text> : null}
    {item.stale ? <Text style={styles.warning}>{t('farmer.prices.staleReference').replace('{date}', date)}</Text> : <Text style={styles.secondary}>{t('farmer.prices.reportedDate').replace('{date}', date)}</Text>}
    {comparison.truncated ? <Text style={styles.warning}>{t('farmer.prices.nearestUnconfirmed')}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { backgroundColor: MarketColors.blueSoft, borderRadius: 12, padding: 12, gap: 4 },
  price: { color: MarketColors.greenDark, fontSize: 17, fontWeight: '800' },
  message: { color: MarketColors.muted, fontSize: 13, lineHeight: 18 },
  secondary: { color: MarketColors.muted, fontSize: 11, lineHeight: 16 },
  warning: { color: '#865800', fontSize: 11, lineHeight: 16, fontWeight: '700' },
});
