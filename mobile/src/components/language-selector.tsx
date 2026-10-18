import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useLanguage } from '@/localization/LanguageProvider';
import type { LanguageCode } from '@/localization/types';

const languageOptions: { code: LanguageCode; labelKey: 'language.english' | 'language.kannada' | 'language.tulu' }[] = [
  { code: 'en', labelKey: 'language.english' },
  { code: 'kn', labelKey: 'language.kannada' },
  { code: 'tcy', labelKey: 'language.tulu' },
];

const languageCodes: Record<LanguageCode, string> = { en: 'EN', kn: 'ಕನ್ನಡ', tcy: 'Tulu' };

export function LanguageSelector() {
  const { language, setLanguage, t } = useLanguage();
  const [visible, setVisible] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('language.open')}
        onPress={() => setVisible(true)}
        style={({ pressed }) => [styles.selectorButton, pressed && styles.pressed]}>
        <Text style={styles.globe} accessibilityElementsHidden>
          ◎
        </Text>
        <Text style={styles.currentLanguage}>{languageCodes[language]}</Text>
      </Pressable>
      <Modal
        animationType="fade"
        transparent
        visible={visible}
        onRequestClose={() => setVisible(false)}>
        <Pressable style={styles.scrim} onPress={() => setVisible(false)}>
          <Pressable style={styles.dialog} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.dialogTitle}>{t('language.title')}</Text>
            {languageOptions.map((option) => {
              const selected = language === option.code;
              const label = t(option.labelKey);
              return (
                <Pressable
                  key={option.code}
                  accessibilityRole="radio"
                  accessibilityLabel={
                    selected ? `${label}, ${t('language.selected')}` : label
                  }
                  accessibilityState={{ selected }}
                  onPress={() => {
                    setLanguage(option.code);
                    setVisible(false);
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    selected && styles.optionSelected,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                    {label}
                  </Text>
                  {selected ? (
                    <View style={styles.selectedBadge}>
                      <Text style={styles.selectedText}>{t('language.selected')}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const colors = {
  green: '#287A49',
  greenSoft: '#E8F3E8',
  background: '#F8F8F2',
  card: '#FFFFFF',
  text: '#24312B',
  muted: '#66746C',
  border: '#E5EAE3',
};

const styles = StyleSheet.create({
  selectorButton: {
    minWidth: 52,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 8,
  },
  globe: { color: colors.green, fontSize: 16 },
  currentLanguage: { color: colors.green, fontSize: 10, fontWeight: '800' },
  pressed: { opacity: 0.72 },
  scrim: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#15221BCC', padding: 24 },
  dialog: { width: '100%', maxWidth: 360, borderRadius: 22, backgroundColor: colors.background, padding: 20 },
  dialogTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 12 },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 13,
    paddingHorizontal: 13,
    marginTop: 6,
  },
  optionSelected: { backgroundColor: colors.greenSoft },
  optionLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  optionLabelSelected: { color: colors.green, fontWeight: '800' },
  selectedBadge: { backgroundColor: colors.card, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 5 },
  selectedText: { color: colors.green, fontSize: 10, fontWeight: '700' },
});
