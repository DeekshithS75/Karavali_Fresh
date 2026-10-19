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

Produce photos are captured through the camera; this flow does not offer photo-library imports. Produce name dictation uses `expo-speech-recognition` and requires a native development build. It is not available in Expo Go. After installing dependencies and adding the config plugin, create or rebuild the development client:

```bash
npx expo run:android
# or npx expo run:ios
```

The web preview uses browser speech recognition where supported. If recognition is unavailable or permission is denied, manual name entry remains available.

## Share the development app on the same Wi-Fi

The development API listens on all network interfaces at port `4000`. To let another device on your Wi-Fi use the app:

1. Keep this computer and your friend's device on the same Wi-Fi network. Guest Wi-Fi or client isolation can block device-to-device access.
2. Find this computer's current LAN IPv4 address (currently `10.183.233.103`) and set `EXPO_PUBLIC_API_URL=http://<LAN-IP>:4000` in `mobile/.env`.
3. Start the backend with `cd ../backend && npm run dev`, then start Expo from `mobile` with `npx expo start --host lan`.
4. On your friend's device, open `http://<LAN-IP>:8081` in a browser. For a native app, install a development APK built with that same `EXPO_PUBLIC_API_URL` value.

The LAN address can change when the computer reconnects to Wi-Fi. This is local-network access; devices outside this Wi-Fi need a deployed HTTPS app and API.

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
