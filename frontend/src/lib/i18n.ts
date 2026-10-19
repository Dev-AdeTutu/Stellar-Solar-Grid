export const SUPPORTED_LOCALES = ["en", "es", "fr", "de", "ar", "sw", "zh"] as const;

export function useTranslation(_namespace?: string) {
  return {
    t: (key: string, options?: any) => {
      if (typeof options === "string") return options;
      if (options && typeof options === "object") {
        let text = key;
        for (const [k, v] of Object.entries(options)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
        return text;
      }
      return key;
    },
  };
}
