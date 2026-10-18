import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BrandHeader, MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';
import { FarmerAuthError, getFarmerProduce, getFarmerSessionState, updateFarmerProducePrice, type FarmerProduce } from '@/features/farmer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';

export default function FarmerAddPriceScreen() {
  const { t, language } = useLanguage();
  const { produceId } = useLocalSearchParams<{ produceId?: string }>();
  const [item, setItem] = useState<FarmerProduce | null>(null);
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getFarmerProduce(controller.signal).then((items) => {
      if (!active) return;
      const found = items.find((candidate) => candidate.id === produceId && candidate.status === 'awaiting_price' && candidate.pricePerUnit == null);
      if (!found) setError('produce.listingNotFound');
      else setItem(found);
      setLoading(false);
    }).catch(async (reason: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (reason instanceof FarmerAuthError && reason.code === 'unauthorized') {
        const state = await getFarmerSessionState();
        if (!active) return;
        if (state === 'missing' || state === 'invalid') { router.replace('/auth/farmer'); return; }
      }
      setError('produce.listingLoadError');
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [produceId, retry]);

  const retryLoad = () => {
    setLoading(true);
    setError(null);
    setRetry((value) => value + 1);
  };

  const save = async () => {
    const parsed = Number(price);
    if (!price.trim() || !Number.isFinite(parsed) || parsed <= 0 || !item) {
      setError('produce.validation.priceInvalid');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateFarmerProducePrice(item.id, String(parsed));
      router.replace({ pathname: '/farmer', params: { producePriceAdded: '1' } });
    } catch (reason) {
      if (reason instanceof FarmerAuthError && reason.code === 'unauthorized') router.replace('/auth/farmer');
      else if (reason instanceof FarmerAuthError && reason.code === 'producePriceAlreadySet') setError('produce.priceAlreadySet');
      else if (reason instanceof FarmerAuthError && reason.code === 'produceNotFound') setError('produce.listingNotFound');
      else if (reason instanceof FarmerAuthError && reason.code === 'producePriceInvalid') setError('produce.validation.priceInvalid');
      else setError('produce.priceSaveError');
    } finally { setSaving(false); }
  };

  const estimate = item && price.trim() && Number.isFinite(Number(price)) && Number(price) > 0
    ? new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.quantity * Number(price))
    : null;

  return <FarmerDashboardGuard><ScreenFrame>
    <BrandHeader role="Farmer" />
    <Pressable accessibilityRole="button" onPress={() => router.replace('/farmer')} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.back')}</Text></Pressable>
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('produce.farmerOnly')}</Text>
      <Text style={styles.title}>{t('produce.addPriceTitle')}</Text>
      <Text style={styles.intro}>{t('produce.addPriceIntro')}</Text>
      {loading ? <View style={styles.loading}><ActivityIndicator color={MarketColors.green} /><Text style={styles.help}>{t('produce.listingLoading')}</Text></View> : error && !item ? <View style={styles.errorBox}>
        <Text accessibilityRole="alert" style={styles.error}>{t(error as Parameters<typeof t>[0])}</Text>
        <Pressable accessibilityRole="button" onPress={retryLoad} style={styles.retry}><Text style={styles.retryText}>{t('produce.listingRetry')}</Text></Pressable>
      </View> : item ? <>
        <Text style={styles.name}>{item.nameTranslations?.[language]?.trim() || item.name}</Text>
        <Text style={styles.help}>{t('produce.availableQuantity').replace('{quantity}', String(item.quantity)).replace('{unit}', t(`produce.unit.${item.unit}` as Parameters<typeof t>[0]))}</Text>
        <View style={styles.field}>
          <Text style={styles.label}>{t('produce.sellingPrice')} *</Text>
          <View style={styles.priceRow}><Text style={styles.currency}>₹</Text><TextInput editable={!saving} value={price} onChangeText={(value) => { setPrice(value.replace(/[^\d.]/g, '')); setError(null); }} keyboardType="decimal-pad" inputMode="decimal" placeholder={t('produce.pricePlaceholder')} placeholderTextColor={MarketColors.muted} accessibilityLabel={`${t('produce.sellingPrice')} ${t(`produce.priceUnit.${item.unit}` as Parameters<typeof t>[0])}`} style={styles.input} /><Text style={styles.unit}>/ {t(`produce.priceUnit.${item.unit}` as Parameters<typeof t>[0])}</Text></View>
          <Text style={styles.help}>{t('produce.askingPriceNote')}</Text>
          {estimate ? <Text style={styles.estimate}>{t('produce.estimatedTotalValue').replace('{amount}', estimate)}</Text> : null}
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{t(error as Parameters<typeof t>[0])}</Text> : null}
        <Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()} style={[styles.save, saving && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.saveText}>{t('produce.addPriceSave')}</Text>}</Pressable>
      </> : null}
    </View>
  </ScreenFrame></FarmerDashboardGuard>;
}

const styles = StyleSheet.create({
  back: { minHeight: 38, justifyContent: 'center', alignSelf: 'flex-start', marginBottom: 8 }, backText: { color: MarketColors.green, fontWeight: '700' },
  card: { backgroundColor: MarketColors.card, borderRadius: 22, borderWidth: 1, borderColor: MarketColors.border, padding: 20, gap: 14 },
  eyebrow: { color: MarketColors.blue, fontSize: 11, fontWeight: '800', letterSpacing: 1 }, title: { color: MarketColors.text, fontSize: 24, fontWeight: '800' }, intro: { color: MarketColors.muted, fontSize: 13, lineHeight: 19 }, name: { color: MarketColors.text, fontSize: 18, fontWeight: '800' },
  field: { gap: 8, marginTop: 6 }, label: { color: MarketColors.text, fontSize: 14, fontWeight: '700' }, priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, currency: { color: MarketColors.text, fontSize: 17, fontWeight: '800' }, input: { minHeight: 48, flex: 1, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background, paddingHorizontal: 12, color: MarketColors.text, fontSize: 15 }, unit: { color: MarketColors.greenDark, fontWeight: '800', fontSize: 13 }, help: { color: MarketColors.muted, fontSize: 12, lineHeight: 17 }, estimate: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '700' },
  loading: { minHeight: 90, gap: 10, justifyContent: 'center', alignItems: 'center' }, errorBox: { backgroundColor: '#FFF4D6', padding: 12, borderRadius: 12, gap: 8 }, error: { color: '#B42318', fontSize: 13, lineHeight: 18 }, retry: { minHeight: 40, justifyContent: 'center', alignSelf: 'flex-start' }, retryText: { color: MarketColors.greenDark, fontWeight: '800' }, save: { minHeight: 50, borderRadius: 13, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center', marginTop: 6 }, saveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' }, disabled: { opacity: 0.55 },
});
