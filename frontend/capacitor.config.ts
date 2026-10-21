import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stellarsolargrid.app',
  appName: 'Stellar Solar Grid',
  webDir: 'out',
  bundledWebRuntime: false,
  server: {
    // For development, use your local backend
    // hostname: 'localhost',
    // androidScheme: 'http',
    // iosScheme: 'http',
    
    // For production, clear hostname to use the built files
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#1e293b', // Tailwind slate-800
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#0ea5e9', // Tailwind sky-500
    },
  },
  android: {
    buildOptions: {
      keystorePath: undefined, // Set in CI/CD
      keystorePassword: undefined, // Set in CI/CD
      keystoreAlias: undefined, // Set in CI/CD
      keystoreAliasPassword: undefined, // Set in CI/CD
    },
  },
  ios: {
    scheme: 'Stellar Solar Grid',
    contentInset: 'always',
  },
};

export default config;
