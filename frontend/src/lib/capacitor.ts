/**
 * Capacitor utilities for native mobile features
 * 
 * This module provides a unified interface for Capacitor plugins
 * with graceful degradation when running in web browser.
 */

import { Capacitor } from '@capacitor/core';
import { App, AppInfo } from '@capacitor/app';
import { Network, ConnectionStatus } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications, Token, ActionPerformed } from '@capacitor/push-notifications';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

// Platform detection
export const isNativePlatform = (): boolean => {
  return Capacitor.isNativePlatform();
};

export const getPlatform = (): 'web' | 'ios' | 'android' => {
  return Capacitor.getPlatform() as 'web' | 'ios' | 'android';
};

export const isIOS = (): boolean => {
  return getPlatform() === 'ios';
};

export const isAndroid = (): boolean => {
  return getPlatform() === 'android';
};

// App lifecycle
export const getAppInfo = async (): Promise<AppInfo | null> => {
  if (!isNativePlatform()) return null;
  
  try {
    return await App.getInfo();
  } catch (error) {
    console.error('Failed to get app info:', error);
    return null;
  }
};

export const addAppStateChangeListener = (callback: (isActive: boolean) => void) => {
  if (!isNativePlatform()) return () => {};
  
  const listener = App.addListener('appStateChange', ({ isActive }) => {
    callback(isActive);
  });
  
  return () => listener.remove();
};

// Network status
export const getNetworkStatus = async (): Promise<ConnectionStatus | null> => {
  try {
    return await Network.getStatus();
  } catch (error) {
    console.error('Failed to get network status:', error);
    return null;
  }
};

export const addNetworkListener = (callback: (status: ConnectionStatus) => void) => {
  const listener = Network.addListener('networkStatusChange', callback);
  return () => listener.remove();
};

// Secure storage (Preferences)
export const setSecureValue = async (key: string, value: string): Promise<void> => {
  try {
    await Preferences.set({ key, value });
  } catch (error) {
    console.error(`Failed to set secure value for key ${key}:`, error);
    throw error;
  }
};

export const getSecureValue = async (key: string): Promise<string | null> => {
  try {
    const { value } = await Preferences.get({ key });
    return value;
  } catch (error) {
    console.error(`Failed to get secure value for key ${key}:`, error);
    return null;
  }
};

export const removeSecureValue = async (key: string): Promise<void> => {
  try {
    await Preferences.remove({ key });
  } catch (error) {
    console.error(`Failed to remove secure value for key ${key}:`, error);
    throw error;
  }
};

// Push notifications
export const requestPushPermissions = async (): Promise<boolean> => {
  if (!isNativePlatform()) {
    console.warn('Push notifications only available on native platforms');
    return false;
  }
  
  try {
    const result = await PushNotifications.requestPermissions();
    return result.receive === 'granted';
  } catch (error) {
    console.error('Failed to request push permissions:', error);
    return false;
  }
};

export const registerPushNotifications = async (): Promise<Token | null> => {
  if (!isNativePlatform()) return null;
  
  try {
    await PushNotifications.register();
    
    return new Promise((resolve) => {
      PushNotifications.addListener('registration', (token: Token) => {
        resolve(token);
      });
      
      PushNotifications.addListener('registrationError', (error: any) => {
        console.error('Push registration error:', error);
        resolve(null);
      });
    });
  } catch (error) {
    console.error('Failed to register push notifications:', error);
    return null;
  }
};

export const addPushNotificationListener = (
  callback: (notification: any) => void
): (() => void) => {
  if (!isNativePlatform()) return () => {};
  
  const receivedListener = PushNotifications.addListener(
    'pushNotificationReceived',
    callback
  );
  
  return () => receivedListener.remove();
};

export const addPushActionListener = (
  callback: (action: ActionPerformed) => void
): (() => void) => {
  if (!isNativePlatform()) return () => {};
  
  const actionListener = PushNotifications.addListener(
    'pushNotificationActionPerformed',
    callback
  );
  
  return () => actionListener.remove();
};

// Haptic feedback
export const triggerHapticFeedback = async (style: ImpactStyle = ImpactStyle.Medium): Promise<void> => {
  if (!isNativePlatform()) return;
  
  try {
    await Haptics.impact({ style });
  } catch (error) {
    // Silently fail on platforms without haptics
  }
};

export const triggerHapticNotification = async (type: 'SUCCESS' | 'WARNING' | 'ERROR' = 'SUCCESS'): Promise<void> => {
  if (!isNativePlatform()) return;
  
  try {
    await Haptics.notification({ type });
  } catch (error) {
    // Silently fail
  }
};

// Status bar
export const setStatusBarStyle = async (style: 'light' | 'dark'): Promise<void> => {
  if (!isNativePlatform()) return;
  
  try {
    await StatusBar.setStyle({
      style: style === 'light' ? Style.Light : Style.Dark,
    });
  } catch (error) {
    console.error('Failed to set status bar style:', error);
  }
};

export const hideStatusBar = async (): Promise<void> => {
  if (!isNativePlatform()) return;
  
  try {
    await StatusBar.hide();
  } catch (error) {
    console.error('Failed to hide status bar:', error);
  }
};

export const showStatusBar = async (): Promise<void> => {
  if (!isNativePlatform()) return;
  
  try {
    await StatusBar.show();
  } catch (error) {
    console.error('Failed to show status bar:', error);
  }
};

// Splash screen
export const hideSplashScreen = async (): Promise<void> => {
  if (!isNativePlatform()) return;
  
  try {
    await SplashScreen.hide();
  } catch (error) {
    console.error('Failed to hide splash screen:', error);
  }
};

// App-specific utilities
export const initializeCapacitor = async (): Promise<void> => {
  if (!isNativePlatform()) {
    console.info('Running in web mode - Capacitor features disabled');
    return;
  }
  
  console.info(`Initializing Capacitor on ${getPlatform()}`);
  
  // Hide splash screen after initialization
  await hideSplashScreen();
  
  // Set status bar style
  await setStatusBarStyle('dark');
  
  // Log app info
  const appInfo = await getAppInfo();
  if (appInfo) {
    console.info('App info:', appInfo);
  }
  
  // Log network status
  const networkStatus = await getNetworkStatus();
  if (networkStatus) {
    console.info('Network status:', networkStatus);
  }
};

export const cleanupCapacitor = (): void => {
  // Remove all listeners
  if (isNativePlatform()) {
    App.removeAllListeners();
    Network.removeAllListeners();
    PushNotifications.removeAllListeners();
  }
};
