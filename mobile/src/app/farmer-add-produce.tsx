import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

import { BrandHeader, MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { FarmerDashboardGuard } from '@/components/farmer-auth-flow';
import { FarmerAuthError, createFarmerProduce, getFarmerMarketQuote, getFarmerSessionState, type FarmerMarketComparison, type FarmerProduce } from '@/features/farmer-auth/client';
import { speechRecognition } from '@/features/produce/speech-recognition';
import { useLanguage } from '@/localization/LanguageProvider';

const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const photoMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

type CapturedPhoto = { uri: string; mimeType?: string; fileSize?: number };
type ProduceLocation = NonNullable<FarmerProduce['location']>;
type FormError = 'nameRequired' | 'nameTooLong' | 'quantityInvalid' | 'priceInvalid' | 'photoCount' | 'photoTooLarge' | 'photoInvalid' | null;

function createSubmissionId() {
  const hex = (length: number) => Math.random().toString(16).slice(2).padEnd(length, '0').slice(0, length);
  const variant = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(8)}${hex(4)}`;
}

export default function FarmerAddProduceScreen() {
  const { t, language } = useLanguage();
  const [name, setName] = useState('');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [quantity, setQuantity] = useState('');
  const [pricePerUnit, setPricePerUnit] = useState('');
  const [unit, setUnit] = useState<FarmerProduce['unit']>('kg');
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [produceLocation, setProduceLocation] = useState<ProduceLocation | null>(null);
  const [locationMessage, setLocationMessage] = useState('produce.locationPending');
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [speechMessage, setSpeechMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [marketQuote, setMarketQuote] = useState<FarmerMarketComparison | null>(null);
  const [marketQuoteLoading, setMarketQuoteLoading] = useState(false);
  const [marketQuoteError, setMarketQuoteError] = useState<string | null>(null);
  const marketQuoteController = useRef<AbortController | null>(null);
  const submissionId = useRef(createSubmissionId());
  const locationCaptureAttempted = useRef(false);

  const captureProduceLocation = async (): Promise<ProduceLocation> => {
    if (locationCaptureAttempted.current) return produceLocation ?? { status: 'unavailable' };
    locationCaptureAttempted.current = true;
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setLocationMessage('produce.locationUnavailable');
        const unavailable = { status: 'unavailable' } as const;
        setProduceLocation(unavailable);
        return unavailable;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (position.coords.accuracy == null || !Number.isFinite(position.coords.latitude) || position.coords.latitude < -90 || position.coords.latitude > 90 ||
          !Number.isFinite(position.coords.longitude) || position.coords.longitude < -180 || position.coords.longitude > 180 ||
          !Number.isFinite(position.coords.accuracy) || position.coords.accuracy < 0 || position.coords.accuracy > 100_000 || !Number.isFinite(position.timestamp)) {
        setLocationMessage('produce.locationUnavailable');
        const unavailable = { status: 'unavailable' } as const;
        setProduceLocation(unavailable);
        return unavailable;
      }
      const captured = {
        status: 'captured' as const,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        capturedAt: new Date(position.timestamp).toISOString(),
      };
      setLocationMessage('produce.locationCaptured');
      setProduceLocation(captured);
      return captured;
    } catch {
      setLocationMessage('produce.locationUnavailable');
      const unavailable = { status: 'unavailable' } as const;
      setProduceLocation(unavailable);
      return unavailable;
    }
  };

  useEffect(() => () => marketQuoteController.current?.abort(), []);

  const resetMarketQuote = () => {
    marketQuoteController.current?.abort();
    marketQuoteController.current = null;
    setMarketQuoteLoading(false);
    setMarketQuote(null);
    setMarketQuoteError(null);
  };

  const showMarketQuote = async () => {
    if (!name.trim() || marketQuoteLoading) return;
    marketQuoteController.current?.abort();
    const controller = new AbortController();
    marketQuoteController.current = controller;
    setMarketQuoteLoading(true);
    setMarketQuoteError(null);
    try {
      const result = await getFarmerMarketQuote({ commodity: name.trim(), unit }, controller.signal);
      setMarketQuote(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof FarmerAuthError && error.code === 'unauthorized') {
        const session = await getFarmerSessionState();
        if (session === 'missing' || session === 'invalid') { router.replace('/auth/farmer'); return; }
      }
      setMarketQuoteError(error instanceof FarmerAuthError && error.code === 'marketPriceNotConfigured' ? 'farmer.prices.notConfigured'
        : error instanceof FarmerAuthError && error.code === 'marketPriceInvalidKey' ? 'farmer.prices.invalidKey'
          : error instanceof FarmerAuthError && error.code === 'marketPriceRateLimited' ? 'farmer.prices.rateLimited'
            : error instanceof FarmerAuthError && error.code === 'marketCommodityUnrecognized' ? 'farmer.prices.unavailableVegetable'
              : 'farmer.prices.quoteError');
    } finally {
      if (marketQuoteController.current === controller) {
        marketQuoteController.current = null;
        setMarketQuoteLoading(false);
      }
    }
  };

  useEffect(() => speechRecognition.subscribe({
    start: () => setRecognizing(true),
    end: () => setRecognizing(false),
    result: (event) => {
      const transcript = event.results.map((result) => result.transcript).filter(Boolean).join(' ').trim();
      if (transcript) {
        setName(transcript);
        submissionId.current = createSubmissionId();
        setSpeechMessage('produce.speechRecognized');
      }
    },
    nomatch: () => { setRecognizing(false); setSpeechMessage('produce.speechNoSpeech'); },
    error: (event) => {
      setRecognizing(false);
      if (event.error === 'aborted') { setSpeechMessage(null); return; }
      setSpeechMessage(event.error === 'not-allowed' ? 'produce.speechPermissionDenied' : event.error === 'no-speech' || event.error === 'speech-timeout' ? 'produce.speechNoSpeech' : 'produce.speechUnavailable');
    },
  }), []);

  const capturePhoto = async (replaceIndex?: number) => {
    setCameraMessage(null);
    if ((replaceIndex === undefined && photos.length >= 5) || capturing || saving) return;
    setCapturing(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { setCameraMessage('produce.cameraPermissionDenied'); return; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85, allowsEditing: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) { setCameraMessage('produce.cameraError'); return; }
      if (asset.fileSize && asset.fileSize > MAX_IMAGE_SIZE) { setFormError('photoTooLarge'); return; }
      if (asset.mimeType && !photoMimeTypes.includes(asset.mimeType)) { setFormError('photoInvalid'); return; }
      setFormError(null);
      if (photos.length === 0 && replaceIndex === undefined) await captureProduceLocation();
      submissionId.current = createSubmissionId();
      setPhotos((current) => replaceIndex === undefined
        ? current.length < 5 ? [...current, { uri: asset.uri, mimeType: asset.mimeType, fileSize: asset.fileSize }] : current
        : current.map((photo, index) => index === replaceIndex ? { uri: asset.uri, mimeType: asset.mimeType, fileSize: asset.fileSize } : photo));
    } catch {
      setCameraMessage('produce.cameraError');
    } finally { setCapturing(false); }
  };

  const toggleSpeech = async () => {
    setSpeechMessage(null);
    if (recognizing) { speechRecognition.stop(); return; }
    if (!speechRecognition.isRecognitionAvailable()) { setSpeechMessage('produce.speechUnsupported'); return; }
    try {
      const permission = await speechRecognition.requestPermissionsAsync();
      if (!permission.granted) { setSpeechMessage('produce.speechPermissionDenied'); return; }
      const lang = language === 'kn' ? 'kn-IN' : 'en-IN';
      speechRecognition.start({ lang, interimResults: true, maxAlternatives: 1, continuous: false });
    } catch {
      setSpeechMessage('produce.speechUnavailable');
    }
  };

  const submit = async () => {
    setFormError(null);
    setSubmitError(null);
    if (!name.trim()) { setFormError('nameRequired'); return; }
    if (name.trim().length > 120) { setFormError('nameTooLong'); return; }
    const parsedQuantity = Number(quantity);
    if (!quantity.trim() || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) { setFormError('quantityInvalid'); return; }
    const parsedPrice = pricePerUnit.trim() ? Number(pricePerUnit) : null;
    if (parsedPrice === null || !Number.isFinite(parsedPrice) || parsedPrice <= 0) { setFormError('priceInvalid'); return; }
    if (photos.length > 5) { setFormError('photoCount'); return; }
    if (photos.some((photo) => photo.fileSize && photo.fileSize > MAX_IMAGE_SIZE)) { setFormError('photoTooLarge'); return; }
    if (photos.some((photo) => photo.mimeType && !photoMimeTypes.includes(photo.mimeType))) { setFormError('photoInvalid'); return; }
    setSaving(true);
    try {
      await createFarmerProduce({ name, sourceLanguage: language, quantity: String(parsedQuantity), unit, location: produceLocation ?? { status: 'unavailable' }, ...(parsedPrice === null ? {} : { pricePerUnit: String(parsedPrice), priceUnit: unit }), photos }, submissionId.current);
      router.replace({ pathname: '/farmer', params: { produceAdded: '1' } });
    } catch (error) {
      if (error instanceof Error && error.message === 'invalidDocument') setSubmitError('produce.uploadInvalid');
      else if (error instanceof Error && error.message === 'unauthorized') router.replace('/auth/farmer');
      else if (error instanceof Error && error.message === 'producePhotoCount') setFormError('photoCount');
      else if (error instanceof Error && error.message === 'producePhotoTooLarge') setFormError('photoTooLarge');
      else if (error instanceof Error && error.message === 'produceImageInvalid') setSubmitError('produce.uploadInvalid');
      else if (error instanceof Error && error.message === 'produceStorageUnavailable') setSubmitError('produce.storageUnavailable');
      else if (error instanceof FarmerAuthError && error.code === 'produceStorageUploadFailed') setSubmitError('produce.storageUploadFailed');
      else if (error instanceof FarmerAuthError && error.code === 'validationFailed') {
        setSubmitError(error.validationDetails.length
          ? t('produce.serverValidationDetails').replace('{details}', error.validationDetails.join('; '))
          : t('produce.serverRejected').replace('{code}', error.serverError ?? 'validation_failed'));
      }
      else if (error instanceof FarmerAuthError && error.code === 'producePriceInvalid') setFormError('priceInvalid');
      else if (error instanceof FarmerAuthError && error.code === 'produceRequestRejected') {
        setSubmitError(t('produce.serverRejected').replace('{code}', error.serverError ?? 'unknown'));
      }
      else if (error instanceof FarmerAuthError && error.code === 'network') setSubmitError('produce.networkError');
      else if (error instanceof FarmerAuthError && ['apiUrlMissing', 'urlNotAllowed'].includes(error.code)) setSubmitError('produce.apiConfigurationError');
      else if (error instanceof FarmerAuthError) setSubmitError(t('produce.serverRejected').replace('{code}', error.code));
      else setSubmitError('produce.saveError');
    } finally { setSaving(false); }
  };

  const translatedFormError = formError ? t(`produce.validation.${formError}` as Parameters<typeof t>[0]) : null;

  const continueFromName = () => {
    if (!name.trim()) { setFormError('nameRequired'); return; }
    if (name.trim().length > 120) { setFormError('nameTooLong'); return; }
    setFormError(null);
    setStep(2);
    void capturePhoto();
  };

  const continueFromPhotos = () => {
    setFormError(null);
    setStep(3);
    if (name.trim()) void showMarketQuote();
  };

  const continueFromDetails = () => {
    const parsedQuantity = Number(quantity);
    const parsedPrice = pricePerUnit.trim() ? Number(pricePerUnit) : null;
    if (!quantity.trim() || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) { setFormError('quantityInvalid'); return; }
    if (parsedPrice !== null && (!Number.isFinite(parsedPrice) || parsedPrice <= 0)) { setFormError('priceInvalid'); return; }
    setFormError(null);
    setStep(4);
  };

  const unitLabel = t(`produce.unit.${unit}` as Parameters<typeof t>[0]);
  const askingPrice = pricePerUnit.trim() ? `₹${pricePerUnit} / ${t(`produce.priceUnit.${unit}` as Parameters<typeof t>[0])}` : t('produce.priceNotAdded');
  const simpleMarketQuote = marketQuote?.items[0];
  const simpleQuoteDate = simpleMarketQuote?.sourceDate ? new Intl.DateTimeFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { dateStyle: 'medium' }).format(new Date(`${simpleMarketQuote.sourceDate}T00:00:00`)) : null;
  const simpleQuoteText = simpleMarketQuote?.unitCompatible && simpleMarketQuote.modalPrice !== null && simpleMarketQuote.priceUnit
    ? `${t('farmer.prices.simpleMandiPrice').replace('{price}', new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(simpleMarketQuote.modalPrice)).replace('{unit}', t(`produce.priceUnit.${simpleMarketQuote.priceUnit.split('/')[1] ?? 'kg'}` as Parameters<typeof t>[0]))}${simpleQuoteDate ? ` · ${simpleQuoteDate}` : ''}${simpleMarketQuote.fallbackLevel === 'other_karnataka' ? ` · ${t('farmer.prices.regionalReference')}` : ''}`
    : null;

  return <FarmerDashboardGuard><ScreenFrame>
    <BrandHeader role="Farmer" />
    <Pressable accessibilityRole="button" onPress={() => step === 1 ? router.replace('/farmer') : setStep((step - 1) as 1 | 2 | 3 | 4)} style={styles.backButton}>
      <Text style={styles.backText}>‹ {t('navigation.back')}</Text>
    </Pressable>
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('produce.stepProgress').replace('{step}', String(step))}</Text>
      <Text style={styles.title}>{step === 1 ? t('produce.name') : step === 2 ? t('produce.photos') : step === 3 ? t('produce.detailsTitle') : t('produce.reviewTitle')}</Text>
      {step === 1 ? <>
        <View style={styles.field}>
          <Text style={styles.label}>{t('produce.name')} *</Text>
          <View style={styles.nameRow}>
            <TextInput autoFocus editable={!saving} value={name} onChangeText={(value) => { setName(value); resetMarketQuote(); setFormError(null); submissionId.current = createSubmissionId(); }} placeholder={t('produce.namePlaceholder')} placeholderTextColor={MarketColors.muted} maxLength={120} accessibilityLabel={t('produce.name')} style={[styles.input, styles.nameInput, styles.largeInput]} />
            <Pressable accessibilityRole="button" accessibilityLabel={t(recognizing ? 'produce.stopSpeech' : 'produce.startSpeech')} disabled={saving} onPress={() => void toggleSpeech()} style={[styles.voiceButton, recognizing && styles.voiceActive]}><Text style={styles.voiceText}>{recognizing ? '■' : '🎙'}</Text></Pressable>
          </View>
          {speechMessage ? <Text accessibilityRole="alert" style={speechMessage === 'produce.speechRecognized' ? styles.successText : styles.help}>{t(speechMessage as Parameters<typeof t>[0])}</Text> : null}
          {translatedFormError ? <Text accessibilityRole="alert" style={styles.error}>{translatedFormError}</Text> : null}
        </View>
        <Pressable accessibilityRole="button" onPress={continueFromName} style={styles.saveButton}><Text style={styles.saveText}>{t('produce.next')}</Text></Pressable>
      </> : null}
      {step === 2 ? <>
        <Text style={styles.help}>{t('produce.photosOptional')}</Text>
        <View style={styles.photoHead}><Text style={styles.label}>{photos.length}/5</Text>{photos.length < 5 ? <Pressable accessibilityRole="button" disabled={capturing || saving} onPress={() => void capturePhoto()} style={styles.captureButton}>{capturing ? <ActivityIndicator color={MarketColors.green} /> : <Text style={styles.captureText}>＋ {photos.length ? t('produce.addAnotherPhoto') : t('produce.capturePhoto')}</Text>}</Pressable> : null}</View>
        <Text accessibilityRole="summary" style={produceLocation?.status === 'captured' ? styles.successText : styles.help}>{t(locationMessage as Parameters<typeof t>[0])}</Text>
        {produceLocation?.status !== 'captured' ? <Text style={styles.help}>{t('produce.locationOptional')}</Text> : null}
        {cameraMessage ? <Text accessibilityRole="alert" style={styles.error}>{t(cameraMessage as Parameters<typeof t>[0])}</Text> : null}
        {photos.length ? <View style={styles.photoGrid}>{photos.map((photo, index) => <View key={`${photo.uri}-${index}`} style={styles.photoCard}>
          <Image source={{ uri: photo.uri }} contentFit="cover" style={styles.photo} accessibilityLabel={`${t('produce.photoPreview')} ${index + 1}`} />
          <Pressable accessibilityRole="button" disabled={saving} accessibilityLabel={`${t('produce.removePhoto')} ${index + 1}`} onPress={() => { submissionId.current = createSubmissionId(); setPhotos((current) => current.filter((_, photoIndex) => photoIndex !== index)); }} style={styles.removePhoto}><Text style={styles.removePhotoText}>×</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={saving || capturing} onPress={() => void capturePhoto(index)} style={styles.retake}><Text style={styles.retakeText}>{t('produce.retakePhoto')}</Text></Pressable>
        </View>)}</View> : null}
        <View style={styles.buttonRow}><Pressable accessibilityRole="button" onPress={continueFromPhotos} style={styles.saveButton}><Text style={styles.saveText}>{t('produce.continue')}</Text></Pressable><Pressable accessibilityRole="button" onPress={continueFromPhotos} style={styles.skipButton}><Text style={styles.skipText}>{t('produce.skipPhotos')}</Text></Pressable></View>
      </> : null}
      {step === 3 ? <>
        <View style={styles.field}><Text style={styles.label}>{t('produce.quantity')} *</Text><TextInput editable={!saving} value={quantity} onChangeText={(value) => { setQuantity(value.replace(/[^\d.]/g, '')); setFormError(null); submissionId.current = createSubmissionId(); }} keyboardType="decimal-pad" inputMode="decimal" accessibilityLabel={t('produce.quantity')} placeholder={t('produce.quantityPlaceholder')} placeholderTextColor={MarketColors.muted} style={[styles.input, styles.largeInput]} /><View style={styles.units}>{(['kg', 'quintal', 'bunch', 'pieces'] as const).map((value) => <Pressable key={value} accessibilityRole="button" disabled={saving} accessibilityState={{ selected: unit === value }} onPress={() => { setUnit(value); resetMarketQuote(); submissionId.current = createSubmissionId(); }} style={[styles.unit, unit === value && styles.unitSelected]}><Text style={[styles.unitText, unit === value && styles.unitTextSelected]}>{t(`produce.unit.${value}` as Parameters<typeof t>[0])}</Text></Pressable>)}</View></View>
        <View style={styles.field}><Text style={styles.label}>{t('produce.sellingPrice')}</Text><View style={styles.priceRow}><Text style={styles.currencyPrefix}>₹</Text><TextInput editable={!saving} value={pricePerUnit} onChangeText={(value) => { setPricePerUnit(value.replace(/[^\d.]/g, '')); setFormError(null); submissionId.current = createSubmissionId(); }} keyboardType="decimal-pad" inputMode="decimal" accessibilityLabel={`${t('produce.sellingPrice')} ${t(`produce.priceUnit.${unit}` as Parameters<typeof t>[0])}`} placeholder={t('produce.pricePlaceholder')} placeholderTextColor={MarketColors.muted} style={[styles.input, styles.priceInput, styles.largeInput]} /><Text style={styles.priceUnit}>/ {t(`produce.priceUnit.${unit}` as Parameters<typeof t>[0])}</Text></View>
          {Number(quantity) > 0 && Number(pricePerUnit) > 0 ? <Text style={styles.estimate}>{t('produce.estimatedTotalValue').replace('{amount}', new Intl.NumberFormat(language === 'kn' ? 'kn-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(quantity) * Number(pricePerUnit)))}</Text> : null}</View>
        <View style={styles.marketQuoteBox}><Text style={styles.label}>{t('farmer.prices.shortReference')}</Text>{marketQuoteLoading ? <ActivityIndicator color={MarketColors.green} /> : simpleQuoteText ? <Text style={styles.quoteButtonText}>{simpleQuoteText}</Text> : marketQuoteError ? <Text accessibilityRole="alert" style={styles.help}>{t(marketQuoteError as Parameters<typeof t>[0])}</Text> : <Text style={styles.help}>{t('farmer.prices.noReference')}</Text>}{marketQuoteError ? <Pressable accessibilityRole="button" onPress={() => void showMarketQuote()}><Text style={styles.quoteButtonText}>{t('farmer.prices.retry')}</Text></Pressable> : null}</View>
        {translatedFormError ? <Text accessibilityRole="alert" style={styles.error}>{translatedFormError}</Text> : null}
        <Pressable accessibilityRole="button" onPress={continueFromDetails} style={styles.saveButton}><Text style={styles.saveText}>{t('produce.next')}</Text></Pressable>
      </> : null}
      {step === 4 ? <>
        <Text style={styles.reviewName}>{name.trim()}</Text>
        {photos.length ? <View style={styles.photoGrid}>{photos.map((photo, index) => <Image key={`${photo.uri}-${index}`} source={{ uri: photo.uri }} contentFit="cover" style={styles.reviewPhoto} accessibilityLabel={`${t('produce.photoPreview')} ${index + 1}`} />)}</View> : null}
        <Text style={styles.reviewLine}>{t('produce.availableQuantity').replace('{quantity}', quantity).replace('{unit}', unitLabel)}</Text>
        <Text style={styles.reviewLine}>{askingPrice}</Text>
        {produceLocation?.status === 'captured' ? <Text style={styles.help}>{t('produce.locationCaptured')}</Text> : <Text style={styles.help}>{t('produce.locationUnavailable')}</Text>}
        {translatedFormError ? <Text accessibilityRole="alert" style={styles.error}>{translatedFormError}</Text> : null}
        {submitError ? <Text accessibilityRole="alert" style={styles.error}>{t(submitError as Parameters<typeof t>[0])}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: saving }} disabled={saving} onPress={() => void submit()} style={[styles.saveButton, saving && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.saveText}>{t('produce.save')}</Text>}</Pressable>
      </> : null}
    </View>
  </ScreenFrame></FarmerDashboardGuard>;
}

const styles = StyleSheet.create({
  backButton: { minHeight: 38, justifyContent: 'center', alignSelf: 'flex-start', marginBottom: 8 }, backText: { color: MarketColors.green, fontWeight: '700' },
  card: { backgroundColor: MarketColors.card, borderRadius: 22, borderWidth: 1, borderColor: MarketColors.border, padding: 20, gap: 15 },
  eyebrow: { color: MarketColors.blue, fontSize: 11, fontWeight: '800', letterSpacing: 1 }, title: { color: MarketColors.text, fontSize: 24, fontWeight: '800', marginTop: -9 }, intro: { color: MarketColors.muted, fontSize: 13, lineHeight: 19, marginTop: -9 },
  field: { gap: 7 }, label: { color: MarketColors.text, fontSize: 14, fontWeight: '700' }, input: { minHeight: 48, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background, paddingHorizontal: 12, color: MarketColors.text, fontSize: 15 }, nameRow: { flexDirection: 'row', gap: 8 }, nameInput: { flex: 1 }, voiceButton: { width: 50, height: 48, borderRadius: 12, backgroundColor: MarketColors.blueSoft, justifyContent: 'center', alignItems: 'center' }, voiceActive: { backgroundColor: '#FDECEC' }, voiceText: { color: MarketColors.blue, fontSize: 19 },
  help: { color: MarketColors.muted, fontSize: 12, lineHeight: 17 }, successText: { color: MarketColors.greenDark, fontSize: 12, fontWeight: '700' }, quantityRow: { gap: 9 }, quantityInput: { width: '100%' }, units: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, unit: { minHeight: 38, borderRadius: 10, borderWidth: 1, borderColor: MarketColors.border, paddingHorizontal: 12, justifyContent: 'center' }, unitSelected: { borderColor: MarketColors.green, backgroundColor: MarketColors.greenSoft }, unitText: { color: MarketColors.text, fontSize: 12, fontWeight: '600' }, unitTextSelected: { color: MarketColors.greenDark, fontWeight: '800' }, priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, currencyPrefix: { color: MarketColors.text, fontSize: 17, fontWeight: '800' }, priceInput: { flex: 1 }, priceUnit: { color: MarketColors.greenDark, fontWeight: '800', fontSize: 13 }, estimate: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '700' },
  marketQuoteBox: { gap: 9, backgroundColor: MarketColors.background, borderRadius: 14, padding: 12 }, quoteButton: { minHeight: 44, borderRadius: 11, borderWidth: 1.3, borderColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' }, quoteButtonText: { color: MarketColors.greenDark, fontWeight: '800' },
  photoHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, photoCount: { color: MarketColors.greenDark, fontWeight: '800' }, captureButton: { minHeight: 48, borderWidth: 1.4, borderColor: MarketColors.green, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, captureText: { color: MarketColors.green, fontWeight: '800' }, photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, photoCard: { width: '31%', minWidth: 90, maxWidth: 150, height: 134, borderRadius: 12, backgroundColor: MarketColors.background, overflow: 'hidden' }, photo: { width: '100%', height: 96 }, removePhoto: { position: 'absolute', right: 5, top: 5, width: 27, height: 27, borderRadius: 14, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }, removePhotoText: { color: '#B42318', fontSize: 21, lineHeight: 24, fontWeight: '800' }, retake: { flex: 1, alignItems: 'center', justifyContent: 'center' }, retakeText: { color: MarketColors.greenDark, fontSize: 11, fontWeight: '700' }, error: { color: '#B42318', fontSize: 13, lineHeight: 18 }, saveButton: { minHeight: 50, borderRadius: 13, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center', marginTop: 3 }, saveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' }, disabled: { opacity: 0.55 }, listingNote: { marginTop: 20, padding: 14, backgroundColor: MarketColors.greenSoft, borderRadius: 14 },
  largeInput: { minHeight: 58, fontSize: 17 }, buttonRow: { gap: 8 }, skipButton: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: MarketColors.border, alignItems: 'center', justifyContent: 'center' }, skipText: { color: MarketColors.greenDark, fontWeight: '800' }, reviewName: { color: MarketColors.text, fontSize: 20, fontWeight: '800' }, reviewLine: { color: MarketColors.text, fontSize: 16, fontWeight: '600' }, reviewPhoto: { width: 86, height: 86, borderRadius: 10, backgroundColor: MarketColors.background },
});
