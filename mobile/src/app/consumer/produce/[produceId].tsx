import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { EmptyState, MarketColors, ScreenFrame, SectionHeading } from '@/components/marketplace-ui';
import { ConsumerAuthError, createConsumerRequestKey, getConsumerListingDetail, getConsumerPhotoHeaders, requestConsumerProduce, type ConsumerListingDetail } from '@/features/consumer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';

export default function ConsumerProduceDetailScreen() {
  const { produceId } = useLocalSearchParams<{ produceId: string }>();
  const { t, language } = useLanguage();
  const [item, setItem] = useState<ConsumerListingDetail | null>(null);
  const [photoHeaders, setPhotoHeaders] = useState<Record<string, string>>({});
  const [failedPhotos, setFailedPhotos] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [quantity, setQuantity] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [sendError, setSendError] = useState(false);
  const requestKey = useRef(createConsumerRequestKey());
  const title = useMemo(() => item?.nameTranslations?.[language]?.trim() || item?.nameTranslations?.en?.trim() || item?.name || '', [item, language]);

  const load = useCallback(async () => {
    if (!produceId) return;
    setLoading(true); setError(false);
    try {
      const [detail, headers] = await Promise.all([getConsumerListingDetail(produceId), getConsumerPhotoHeaders()]);
      setItem(detail); setPhotoHeaders(headers);
    } catch (reason) {
      if (reason instanceof ConsumerAuthError && reason.code === 'unauthorized') router.replace('/auth/consumer/login');
      else setError(true);
    } finally { setLoading(false); }
  }, [produceId]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const submit = async () => {
    const amount = Number(quantity);
    if (!item || !Number.isFinite(amount) || amount <= 0 || amount > item.quantity) { setSendError(true); return; }
    setSending(true); setSendError(false); setMessage('');
    try {
      await requestConsumerProduce(item.id, amount, requestKey.current);
      setMessage(t('consumer.requestSent'));
      setQuantity('');
      requestKey.current = createConsumerRequestKey();
    } catch (reason) {
      if (reason instanceof ConsumerAuthError && reason.code === 'unauthorized') router.replace('/auth/consumer/login');
      else setSendError(true);
    } finally { setSending(false); }
  };

  return <ScreenFrame>
    <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.returnToWelcome')}</Text></Pressable>
    {loading ? <View style={styles.center}><ActivityIndicator color={MarketColors.green} /></View> : error ? <View style={styles.panel}><Text accessibilityRole="alert" style={styles.error}>{t('consumer.loadError')}</Text><Pressable accessibilityRole="button" onPress={() => void load()} style={styles.button}><Text style={styles.buttonText}>{t('consumer.retry')}</Text></Pressable></View> : !item ? <EmptyState icon="🥬" title={t('consumer.emptyTitle')} message={t('consumer.emptyMessage')} /> : <View style={styles.panel}>
      {item.photoUrls.some((_url, index) => !failedPhotos.includes(index)) ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery}>{item.photoUrls.map((url, index) => failedPhotos.includes(index) ? null : <Image key={url} source={{ uri: url, headers: photoHeaders }} contentFit="cover" onError={() => setFailedPhotos((current) => [...current, index])} style={styles.photo} accessibilityLabel={t('consumer.photo') + ' ' + title} />)}</ScrollView> : <View style={styles.photoFallback}><Text style={styles.fallbackIcon}>🥬</Text></View>}
      <SectionHeading title={title} />
      <Text style={styles.price}>{t('consumer.askingPrice')}: {new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.pricePerUnit)} / {t(('produce.priceUnit.' + item.priceUnit) as never)}</Text>
      {item.marketComparison?.status === 'available' && item.marketComparison.items.some((quote) => quote.modalPrice !== null && !quote.stale) ? <><Text style={styles.market}>{t('consumer.marketPrice')}: {new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(item.marketComparison.items.find((quote) => quote.modalPrice !== null && !quote.stale)!.modalPrice!)} / {t(('produce.priceUnit.' + item.priceUnit) as never)} · {item.marketComparison.items.find((quote) => quote.modalPrice !== null && !quote.stale)!.sourceDate}</Text><Text style={styles.help}>{t('consumer.marketRegional')}</Text></> : <Text style={styles.help}>{t('consumer.marketUnavailable')}</Text>}
      <Text style={styles.help}>{t('consumer.quantityAvailable').replace('{quantity}', String(item.quantity)).replace('{unit}', t(('produce.unit.' + item.unit) as never))}</Text>
      {item.farmerName ? <Text style={styles.help}>{t('consumer.farmerName')}: {item.farmerName}</Text> : null}
      <Text style={styles.help}>{t('consumer.locationNotShared')}</Text>
      <TextInput accessibilityLabel={t('consumer.requestQuantity')} keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} placeholder={t('consumer.requestQuantity')} style={styles.input} />
      {sendError ? <Text accessibilityRole="alert" style={styles.error}>{t('consumer.requestError')}</Text> : message ? <Text accessibilityRole="alert" style={styles.success}>{message}</Text> : null}
      <Pressable accessibilityRole="button" disabled={sending} onPress={() => void submit()} style={[styles.button, sending && styles.disabled]}><Text style={styles.buttonText}>{t(sending ? 'consumer.requestSending' : 'consumer.requestSubmit')}</Text></Pressable>
    </View>}
  </ScreenFrame>;
}

const styles = StyleSheet.create({
  back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 6 }, backText: { color: MarketColors.greenDark, fontWeight: '800' },
  center: { minHeight: 260, alignItems: 'center', justifyContent: 'center' }, panel: { gap: 12, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: MarketColors.border, backgroundColor: MarketColors.card }, gallery: { gap: 8 }, photo: { width: 270, height: 240, borderRadius: 14, backgroundColor: MarketColors.background }, photoFallback: { height: 180, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: MarketColors.greenSoft }, fallbackIcon: { fontSize: 50 }, price: { color: MarketColors.greenDark, fontSize: 17, fontWeight: '800' }, market: { color: MarketColors.blue, fontSize: 13, lineHeight: 19, fontWeight: '700' }, help: { color: MarketColors.muted, fontSize: 13, lineHeight: 19 }, input: { minHeight: 48, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, paddingHorizontal: 12, color: MarketColors.text }, button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: MarketColors.green }, buttonText: { color: '#fff', fontSize: 14, fontWeight: '800' }, disabled: { opacity: 0.5 }, error: { color: '#B42318', fontSize: 13 }, success: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '700' },
});
