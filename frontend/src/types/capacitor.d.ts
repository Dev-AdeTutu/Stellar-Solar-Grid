declare module '@capacitor/core' {
  export const Capacitor: {
    isNativePlatform(): boolean;
    getPlatform(): string;
    [key: string]: any;
  };
}

declare module '@capacitor/app' {
  export interface AppInfo {
    [key: string]: any;
  }
  export const App: {
    getInfo(): Promise<AppInfo>;
    addListener(event: string, cb: (val: any) => void): { remove: () => void };
    removeAllListeners(): Promise<void>;
    [key: string]: any;
  };
}

declare module '@capacitor/network' {
  export interface ConnectionStatus {
    connected: boolean;
    connectionType: string;
    [key: string]: any;
  }
  export const Network: {
    getStatus(): Promise<ConnectionStatus>;
    addListener(event: string, cb: (status: ConnectionStatus) => void): { remove: () => void };
    removeAllListeners(): Promise<void>;
    [key: string]: any;
  };
}

declare module '@capacitor/preferences' {
  export const Preferences: {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
    remove(options: { key: string }): Promise<void>;
    clear(): Promise<void>;
    [key: string]: any;
  };
}

declare module '@capacitor/push-notifications' {
  export interface Token {
    value: string;
  }
  export interface ActionPerformed {
    [key: string]: any;
  }
  export const PushNotifications: {
    requestPermissions(): Promise<any>;
    register(): Promise<void>;
    addListener(event: string, cb: (val: any) => void): { remove: () => void };
    removeAllListeners(): Promise<void>;
    [key: string]: any;
  };
}

declare module '@capacitor/haptics' {
  export enum ImpactStyle {
    Heavy = 'HEAVY',
    Medium = 'MEDIUM',
    Light = 'LIGHT',
  }
  export const Haptics: {
    impact(options?: { style: ImpactStyle }): Promise<void>;
    notification(options?: { type: string }): Promise<void>;
    vibrate(options?: { duration: number }): Promise<void>;
    [key: string]: any;
  };
}

declare module '@capacitor/status-bar' {
  export enum Style {
    Dark = 'DARK',
    Light = 'LIGHT',
    Default = 'DEFAULT',
  }
  export const StatusBar: {
    setStyle(options: { style: Style }): Promise<void>;
    setBackgroundColor(options: { color: string }): Promise<void>;
    hide(): Promise<void>;
    show(): Promise<void>;
    [key: string]: any;
  };
}

declare module '@capacitor/splash-screen' {
  export const SplashScreen: {
    hide(): Promise<void>;
    show(options?: any): Promise<void>;
    [key: string]: any;
  };
}
