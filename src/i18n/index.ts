import * as Localization from 'expo-localization';

export type SupportedLanguage =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'ru'
  | 'zh'
  | 'ja'
  | 'pt'
  | 'ko'
  | 'it'
  | 'tr'
  | 'ar'
  | 'fa'
  | 'el';

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'en',
  'es',
  'fr',
  'de',
  'ru',
  'zh',
  'ja',
  'pt',
  'ko',
  'it',
  'tr',
  'ar',
  'fa',
  'el',
];

export const translations = {
  "en": {
    "appName": "VoiceCrisp",
    "proBadge": "PRO",
    "back": "Back",
    "cancel": "Cancel",
    "error": "Error",
    "heroBadge": "BROADCAST STANDARD",
    "heroTitle": "Your voice, cleaned up.",
    "heroSubtitle": "Rumble out, mud out, presence up, and levelled to the loudness the platforms expect. All on your phone.",
    "chooseFile": "Choose a Recording",
    "replaceFile": "Choose a Different Recording",
    "noFileTitle": "No Recording Selected",
    "noFileDesc": "Pick a voice recording to clean it up.",
    "fileUnreadable": "This File Cannot Be Read",
    "fileUnreadableDesc": "The audio could not be opened. Try a different recording.",
    "noAudioTitle": "No Audio Found",
    "noAudioDesc": "This file has no audio track to clean.",
    "fileReady": "{rate} kHz - {duration}",
    "secondsShort": "{seconds}s",
    "minutesShort": "{minutes}m {seconds}s",
    "clean": "Clean It Up",
    "decoding": "Reading the audio...",
    "cleaning": "Cleaning...",
    "encoding": "Writing the file...",
    "cleanFailed": "Cleanup Failed",
    "resultTitle": "What Changed",
    "loudnessBefore": "Loudness before",
    "loudnessAfter": "Loudness after",
    "peakAfter": "Peak",
    "gainApplied": "Gain applied",
    "peakLimitedNote": "Gain was held back to keep the peak under the ceiling, so this sits below the loudness target on purpose. Raising it further would clip.",
    "lufsUnit": "{value} LUFS",
    "dbUnit": "{value} dB",
    "save": "Save to Files",
    "share": "Share",
    "saved": "Saved!",
    "savedDesc": "The cleaned recording is in your Files.",
    "saveFailed": "Save Failed",
    "freeLimitNotice": "Free cleanups cover the first {seconds} seconds. Unlock VoiceCrisp Pro for recordings of any length.",
    "archGuarantees": "WHAT YOU GET",
    "loudnessTitle": "Levelled to -14 LUFS",
    "loudnessDesc": "The loudness TikTok, YouTube and Reels normalise to, so the platform leaves your audio alone.",
    "chainTitle": "A real cleanup chain",
    "chainDesc": "High-pass, mud cut, presence lift and gentle levelling, in the order that actually works.",
    "onDeviceTitle": "100% private on-device",
    "onDeviceDesc": "Your recording never leaves the phone. No server, no account, no tracking.",
    "paywallTitle": "VoiceCrisp Pro",
    "lifetimeAccess": "Unlock Lifetime Access - {price}",
    "lifetimeAccessPlain": "Unlock Lifetime Access",
    "restorePurchases": "Restore Purchases",
    "oneTimePayment": "One-time payment. Never recurring.",
    "termsOfUse": "Terms of Use",
    "privacyPolicy": "Privacy Policy",
    "antiSubTitle": "ANTI-SUBSCRIPTION PROMISE",
    "antiSubHeadline": "No Subscriptions. No Accounts. 100% On-Device Privacy. Own It Forever.",
    "antiSubDesc": "Audio cleanup tools charge $10-$30 every month and upload your recordings to do it. VoiceCrisp is one purchase you keep forever, and it never uploads anything.",
    "storeUnavailable": "Store Unavailable",
    "noPriorPurchases": "No previous purchase was found for this account.",
    "cancelled": "Purchase Cancelled",
    "unlocked": "VoiceCrisp Pro Unlocked",
    "purchaseFailed": "Purchase Failed",
    "purchaseFailedDesc": "The purchase could not be completed. Please try again.",
    "restoreFailed": "Nothing to Restore",
    "restoreFailedDesc": "No previous purchase was found for this account.",
    "feat1Title": "Recordings of any length",
    "feat1Desc": "The free tier covers the first two minutes; Pro cleans the whole take.",
    "feat2Title": "Broadcast loudness",
    "feat2Desc": "BS.1770 measurement and true-peak limiting, the same standard broadcasters use.",
    "feat3Title": "Full-quality export",
    "feat3Desc": "Cleaned audio written at the recording's own sample rate, ready to post.",
    "feat4Title": "100% private on-device",
    "feat4Desc": "Your recording never leaves the phone. No server, no account, no tracking."
  }
} as const;

export type TranslationKey = keyof typeof translations['en'];

export function getDeviceLanguage(): SupportedLanguage {
  try {
    const locales = Localization.getLocales();
    const code = locales?.[0]?.languageCode?.toLowerCase();
    if (code && (SUPPORTED_LANGUAGES as string[]).includes(code)) {
      return code as SupportedLanguage;
    }
  } catch {
    // fallback
  }
  return 'en';
}

let currentLanguage: SupportedLanguage = getDeviceLanguage();

export function setLanguage(lang: SupportedLanguage) {
  currentLanguage = lang;
}

export function getLanguage(): SupportedLanguage {
  return currentLanguage;
}

export function isRTL(): boolean {
  return currentLanguage === 'ar' || currentLanguage === 'fa';
}

/**
 * CLDR plural category for `count` in the active language, e.g. "one" or
 * "other" in English, which also has "few"/"many" in Russian and Arabic.
 *
 * Falls back to an English-style one/other split where Intl.PluralRules is
 * unavailable, which is still better than always rendering the plural form.
 */
function pluralCategory(count: number): string {
  try {
    return new Intl.PluralRules(currentLanguage).select(count);
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const langDict = (translations as any)[currentLanguage] || translations.en;
  // A key may carry plural variants as suffixed siblings ("exportClips_one").
  // Only keys that actually define one are affected; everything else resolves
  // to the base key exactly as before.
  let resolved: string = key as string;
  if (params && typeof params.count === 'number') {
    const variant = `${key}_${pluralCategory(params.count)}`;
    if (langDict[variant] || (translations.en as any)[variant]) resolved = variant;
  }
  let text: string =
    langDict[resolved] || (translations.en as any)[resolved] ||
    langDict[key] || translations.en[key] || (key as string);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.split('{' + k + '}').join(String(v));
    });
  }
  return text;
}

export default t;
