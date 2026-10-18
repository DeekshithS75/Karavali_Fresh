import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';

export default function RootLayout() {
  return (
    <ThemeProvider value={DefaultTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#F8F8F2' },
        }}
      />
    </ThemeProvider>
  );
}
