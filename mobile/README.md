# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

## Farmer produce entry

## Consumer account and dashboard

Choose **Continue as Consumer** on the welcome screen, create an account with an email address and a password of at least 10 characters, or sign in. Consumer credentials are sent only to the backend; the returned token is stored in SecureStore on Android/iOS and validated when the dashboard opens. Logout revokes the server session. The backend does not yet send email verification or password-reset messages, so password recovery is not available.

The dashboard reads only published Farmer listings. A complete Farmer submission includes the farmer's asking price and is published by the backend as part of the final save. Listings without a valid asking price remain private drafts; the mandi reference is optional guidance and is never used as the selling price. Setting a price on an older unpriced draft publishes it. There is no second Publish action on the dashboard.

Consumers can search and browse paginated listings, open a product detail screen, request an available quantity, and see an AGMARKNET reference price when a fresh compatible report exists. The farmer's asking price remains clearly separate. Nearby browse asks for foreground location permission and a distance of 5, 10, 25, 50, or 100 km; Farmer GPS coordinates and contact details are never included in public listing responses.

Farmer request updates are persisted in the Notifications screen. Push token registration and server delivery use Expo Push Service, but this repository has no EAS project ID or configured device credentials. Push registration therefore remains inactive until the app is linked to an EAS project and installed as a development/release build. Expo Go on Android does not support remote push delivery for this SDK. Background or closed-app delivery has not been verified on a physical device.

Produce photos are captured through the camera; this flow does not offer photo-library imports. Produce name dictation uses `expo-speech-recognition` and requires a native development build. It is not available in Expo Go. After installing dependencies and adding the config plugin, create or rebuild the development client:

```bash
npx expo run:android
# or npx expo run:ios
```

The web preview uses browser speech recognition where supported. If recognition is unavailable or permission is denied, manual name entry remains available.

## Share the development app on the same Wi-Fi

The development API listens on all network interfaces at port `4000`. To let another device on your Wi-Fi use the app:

1. Keep the computer and phone on the same Wi-Fi or USB-tether network. Guest Wi-Fi, client isolation, or the computer firewall can block device-to-device access.
2. Find the computer's current IPv4 address with `ip -4 route get 1.1.1.1` and set `EXPO_PUBLIC_API_URL=http://<address>:4000` in the ignored `mobile/.env`. Do not use `localhost` for a phone.
3. Start the backend from `backend` with `npm run dev`, then start Expo from `mobile` with `npx expo start --host lan -c` so Metro reloads the environment value.
4. Confirm `http://<address>:4000/health` returns `{"status":"ok"}` from the phone's browser, then open the Expo app. A standalone native build must be rebuilt with the same API URL.

The LAN address can change when the computer reconnects to Wi-Fi. This is local-network access; devices outside this network need a deployed HTTPS API.

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **example** directory and create a blank **src/app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
