import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  BrandHeader,
  EmptyState,
  MarketColors,
  ScreenFrame,
  SectionHeading,
} from '@/components/marketplace-ui';

const categories = [
  { label: 'Vegetables', icon: '🥬' },
  { label: 'Fruits', icon: '🍌' },
  { label: 'Local Produce', icon: '🥥' },
];

export default function ConsumerHomeScreen() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <ScreenFrame>
      <BrandHeader role="Consumer" />

      <View style={styles.welcomePanel}>
        <Text style={styles.eyebrow}>FRESH FROM AROUND YOU</Text>
        <Text style={styles.greeting}>Welcome home 🧺</Text>
        <Text style={styles.intro}>Find a little more of the coast in the food you bring home.</Text>
      </View>

      <View style={styles.searchBox}>
        <Text style={styles.searchIcon} accessibilityElementsHidden>
          ⌕
        </Text>
        <TextInput
          accessibilityLabel="Search produce or farmers"
          placeholder="Search produce or farmers"
          placeholderTextColor={MarketColors.muted}
          returnKeyType="search"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={styles.searchInput}
        />
      </View>

      <View style={styles.categorySection}>
        <SectionHeading title="Browse categories" />
        <View style={styles.categories}>
          {categories.map((category) => {
            const selected = selectedCategory === category.label;
            return (
              <Pressable
                key={category.label}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setSelectedCategory(selected ? null : category.label)}
                style={({ pressed }) => [
                  styles.categoryCard,
                  selected && styles.categorySelected,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.categoryIcon} accessibilityElementsHidden>
                  {category.icon}
                </Text>
                <Text style={[styles.categoryLabel, selected && styles.categoryLabelSelected]}>
                  {category.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Nearby Farmers" detail="Meet growers in your community" />
        <EmptyState
          icon="👩🏽‍🌾"
          title="No farmer profiles to show yet"
          message="Local farmer profiles will appear here as they join Karavali Fresh."
          tone="blue"
        />
      </View>

      <View style={styles.section}>
        <SectionHeading title="Fresh Produce" detail="Seasonal finds from the coast" />
        <EmptyState
          icon="🧺"
          title="Fresh listings are on their way"
          message="There are no produce listings yet. Check back as local growers join in."
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
