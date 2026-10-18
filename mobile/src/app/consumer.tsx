import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  BrandHeader,
  EmptyState,
  MarketColors,
  ScreenFrame,
  SectionHeading,
} from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import type { TranslationKey } from '@/localization/types';

const categories = [
  { titleKey: 'consumer.category.vegetables', icon: '🥬' },
  { titleKey: 'consumer.category.fruits', icon: '🍌' },
  { titleKey: 'consumer.category.localProduce', icon: '🥥' },
] as const;

export default function ConsumerHomeScreen() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { t } = useLanguage();

  return (
    <ScreenFrame>
      <BrandHeader role="Consumer" />

      <View style={styles.welcomePanel}>
        <Text style={styles.eyebrow}>{t('consumer.eyebrow')}</Text>
        <Text style={styles.greeting}>{t('consumer.greeting')}</Text>
        <Text style={styles.intro}>{t('consumer.intro')}</Text>
      </View>

      <View style={styles.searchBox}>
        <Text style={styles.searchIcon} accessibilityElementsHidden>
          ⌕
        </Text>
        <TextInput
          accessibilityLabel={t('consumer.searchAccessibility')}
          placeholder={t('consumer.searchPlaceholder')}
          placeholderTextColor={MarketColors.muted}
          returnKeyType="search"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={styles.searchInput}
        />
      </View>

      <View style={styles.categorySection}>
        <SectionHeading title={t('consumer.categories.title')} />
        <View style={styles.categories}>
          {categories.map((category) => {
            const titleKey: TranslationKey = category.titleKey;
            const label = t(titleKey);
            const selected = selectedCategory === category.titleKey;
            return (
              <Pressable
                key={category.titleKey}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected }}
                onPress={() => setSelectedCategory(selected ? null : category.titleKey)}
                style={({ pressed }) => [
                  styles.categoryCard,
                  selected && styles.categorySelected,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.categoryIcon} accessibilityElementsHidden>
                  {category.icon}
                </Text>
                <Text style={[styles.categoryLabel, selected && styles.categoryLabelSelected]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('consumer.farmers.title')} detail={t('consumer.farmers.detail')} />
        <EmptyState
          icon="👩🏽‍🌾"
          title={t('consumer.farmers.emptyTitle')}
          message={t('consumer.farmers.emptyMessage')}
          tone="blue"
        />
      </View>

      <View style={styles.section}>
        <SectionHeading title={t('consumer.produce.title')} detail={t('consumer.produce.detail')} />
        <EmptyState
          icon="🧺"
          title={t('consumer.produce.emptyTitle')}
          message={t('consumer.produce.emptyMessage')}
        />
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  welcomePanel: {
    backgroundColor: MarketColors.greenSoft,
    borderRadius: 22,
    padding: 20,
    marginBottom: 15,
  },
  eyebrow: { color: MarketColors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  greeting: { color: MarketColors.text, fontSize: 25, lineHeight: 31, fontWeight: '800', marginTop: 8 },
  intro: { color: MarketColors.muted, fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 540 },
  searchBox: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: MarketColors.card,
    borderWidth: 1,
    borderColor: MarketColors.border,
    borderRadius: 14,
    paddingHorizontal: 13,
    marginBottom: 23,
  },
  searchIcon: { color: MarketColors.green, fontSize: 24, lineHeight: 27, marginRight: 9 },
  searchInput: { flex: 1, minHeight: 48, color: MarketColors.text, fontSize: 14 },
  categorySection: { marginBottom: 24 },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  categoryCard: {
    flexGrow: 1,
    flexBasis: 105,
    minHeight: 89,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: MarketColors.border,
    borderRadius: 16,
    backgroundColor: MarketColors.card,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  categorySelected: { borderColor: MarketColors.green, backgroundColor: MarketColors.greenSoft },
  categoryIcon: { fontSize: 23 },
  categoryLabel: { color: MarketColors.text, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  categoryLabelSelected: { color: MarketColors.greenDark },
  section: { marginBottom: 22 },
  pressed: { opacity: 0.72 },
});
