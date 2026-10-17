declare module '@capacitor/core' {
  export const Capacitor: {
    isNativePlatform: () => boolean;
    getPlatform: () => string;
  };
}

declare module '@capacitor/app' {
  export interface AppInfo {
    name: string;
    id: string;
    build: string;
    version: string;
  }
  export const App: {
    getInfo: () => Promise<AppInfo>;
    addListener: (event: string, callback: (...args: any[]) => void) => any;
    removeAllListeners: () => Promise<void> | any;
    exitApp: () => Promise<void>;
  };
}

declare module '@capacitor/network' {
  export interface ConnectionStatus {
    connected: boolean;
    connectionType: string;
  }
  export const Network: {
    getStatus: () => Promise<ConnectionStatus>;
    addListener: (event: string, callback: (status: ConnectionStatus) => void) => any;
    removeAllListeners: () => Promise<void> | any;
  };
}

declare module '@capacitor/preferences' {
  export const Preferences: {
    get: (opts: { key: string }) => Promise<{ value: string | null }>;
    set: (opts: { key: string; value: string }) => Promise<void>;
    remove: (opts: { key: string }) => Promise<void>;
    clear: () => Promise<void>;
  };
}

declare module '@capacitor/push-notifications' {
  export interface Token {
    value: string;
  }
  export interface ActionPerformed {
    actionId: string;
    notification: any;
  }
  export const PushNotifications: {
    requestPermissions: () => Promise<{ receive: string }>;
    register: () => Promise<void>;
    addListener: (event: string, callback: (...args: any[]) => void) => any;
    removeAllListeners: () => Promise<void> | any;
  };
}

declare module '@capacitor/haptics' {
  export enum ImpactStyle {
    Heavy = 'HEAVY',
    Medium = 'MEDIUM',
    Light = 'LIGHT',
  }
  export const Haptics: {
    impact: (opts: { style: ImpactStyle }) => Promise<void>;
    notification: (opts: any) => Promise<void>;
    vibrate: (opts?: any) => Promise<void>;
  };
}

declare module '@capacitor/status-bar' {
  export enum Style {
    Dark = 'DARK',
    Light = 'LIGHT',
    Default = 'DEFAULT',
  }
  export const StatusBar: {
    setStyle: (opts: { style: Style }) => Promise<void>;
    setBackgroundColor: (opts: { color: string }) => Promise<void>;
    show: () => Promise<void>;
    hide: () => Promise<void>;
  };
}

declare module '@capacitor/splash-screen' {
  export const SplashScreen: {
    show: (opts?: any) => Promise<void>;
    hide: (opts?: any) => Promise<void>;
  };
}
