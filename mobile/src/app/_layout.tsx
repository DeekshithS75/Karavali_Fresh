import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';

import { LanguageProvider } from '@/localization/LanguageProvider';

export default function RootLayout() {
  return (
    <LanguageProvider>
      <ThemeProvider value={DefaultTheme}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#F8F8F2' },
          }}
        />
      </ThemeProvider>
    </LanguageProvider>
  );
}
