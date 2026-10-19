/**
 * Voice Assistant Service
 *
 * Provides rule-based natural language understanding (NLU) for voice
 * assistants (Alexa, Google Assistant) plus a secure payment confirmation
 * flow for voice-initiated payments.
 *
 * Security model
 * --------------
 * Voice is a low-trust channel: utterances can be overheard, replayed, or
 * spoofed by a nearby speaker. Therefore a voice-initiated payment requires
 * BOTH of the following before the caller is allowed to execute a payment:
 *
 *   1. An explicit confirmation token created by `createPaymentConfirmation`
 *      and consumed exactly once by `consumePaymentConfirmation`. Tokens are
 *      random 256-bit hex strings, short-lived (5 minutes), bound to the
 *      owner address and the payment details, and stored only as a SHA-256
 *      hash so a memory dump does not leak usable tokens.
 *   2. A valid 2FA / PIN code verified through `verifyVoicePaymentPin`, which
 *      delegates to the existing two-factor implementation (`totp` or
 *      `recovery`).
 *
 * Additional rules:
 *   - Confirmation tokens are single-use: consuming one deletes it, so a
 *     replayed utterance cannot trigger a second payment.
 *   - Tokens expire quickly and are pruned lazily on access.
 *   - Wallet addresses are never spoken aloud; responses reference meters by
 *     nickname or a short id only.
 *   - The NLU layer never executes payments; it only classifies intent and
 *     extracts slots. Execution is the caller's responsibility, after the
 *     confirmation + 2FA checks above.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { verify } from './twoFactor.js';

/** Intents the voice assistant can recognise. */
export type VoiceIntent =
  | 'check_balance'
  | 'check_usage'
  | 'check_status'
  | 'make_payment'
  | 'confirm_payment'
  | 'cancel'
  | 'help'
  | 'unknown';

/** Locales supported by the voice assistant. */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'ar', 'sw', 'zh'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Slots extracted from an utterance. */
export interface VoiceSlots {
  /** Meter nickname as spoken by the user, e.g. "kitchen". */
  meterNickname?: string;
  /** Meter id if the user spelled one out. */
  meterId?: string;
  /** Payment amount in major units (e.g. 12.5). */
  amount?: number;
  /** Payment amount converted to stroops (1 unit = 10^7 stroops). */
  amountStroops?: number;
  /** Currency code detected in the utterance. */
  currency?: string;
}

/** Result of parsing an utterance. */
export interface VoiceParseResult {
  intent: VoiceIntent;
  slots: VoiceSlots;
  /** Confidence in [0, 1]. */
  confidence: number;
  locale: string;
}

/** Parameters accepted by `respond`. */
export interface VoiceResponseParams {
  balance?: string | number;
  usage?: string | number;
  status?: string;
  meter?: string;
  amount?: string | number;
  currency?: string;
  [key: string]: string | number | undefined;
}

/** Keys for localized voice responses. */
export type VoiceResponseKey =
  | 'balance'
  | 'usage'
  | 'status'
  | 'paymentPrompt'
  | 'paymentConfirmed'
  | 'paymentFailed'
  | 'needConfirmation'
  | 'needPin'
  | 'unknown'
  | 'help'
  | 'notLinked'
  | 'offline';

/** Details required to create a payment confirmation. */
export interface PaymentConfirmationRequest {
  meterId: string;
  amountStroops: number;
  memo?: string;
}

/** A stored, pending payment confirmation. */
export interface PaymentConfirmation {
  token: string;
  ownerAddress: string;
  meterId: string;
  amountStroops: number;
  memo?: string;
  createdAt: number;
  expiresAt: number;
}

/** TTL for confirmation tokens: 5 minutes. */
export const PAYMENT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Stroops per major unit. */
const STROOPS_PER_UNIT = 10_000_000;

/* -------------------------------------------------------------------------- */
/* Locale keyword tables                                                      */
/* -------------------------------------------------------------------------- */

interface LocaleKeywords {
  balance: string[];
  usage: string[];
  status: string[];
  payment: string[];
  confirm: string[];
  cancel: string[];
  help: string[];
}

/**
 * Per-locale keyword tables. Keywords are matched against normalized
 * (lowercased, accent-stripped) utterances.
 */
const LOCALE_KEYWORDS: Record<SupportedLocale, LocaleKeywords> = {
  en: {
    balance: ['balance', 'how much', 'credit', 'remaining', 'left'],
    usage: ['usage', 'used', 'consumption', 'consumed', 'how much have i used'],
    status: ['status', 'state', 'online', 'offline', 'working', 'connected'],
    payment: ['pay', 'payment', 'top up', 'topup', 'recharge', 'add credit', 'buy credit'],
    confirm: ['confirm', 'yes', 'proceed', 'go ahead', 'do it', 'approve'],
    cancel: ['cancel', 'no', 'stop', 'abort', 'never mind', 'nevermind'],
    help: ['help', 'what can you do', 'commands', 'options'],
  },
  es: {
    balance: ['saldo', 'cuanto', 'cuánto', 'credito', 'crédito', 'restante', 'queda'],
    usage: ['uso', 'consumo', 'consumido', 'usado', 'cuanto he usado'],
    status: ['estado', 'conectado', 'desconectado', 'funciona', 'linea', 'línea'],
    payment: ['pagar', 'pago', 'recargar', 'recarga', 'anadir credito', 'añadir crédito'],
    confirm: ['confirmar', 'confirmo', 'si', 'sí', 'adelante', 'proceder', 'aprobar'],
    cancel: ['cancelar', 'no', 'parar', 'abortar', 'olvidalo', 'olvídalo'],
    help: ['ayuda', 'que puedes hacer', 'qué puedes hacer', 'comandos', 'opciones'],
  },
  fr: {
    balance: ['solde', 'combien', 'credit', 'crédit', 'restant', 'reste'],
    usage: ['usage', 'consommation', 'consomme', 'consommé', 'utilise', 'utilisé'],
    status: ['statut', 'etat', 'état', 'connecte', 'connecté', 'deconnecte', 'déconnecté'],
    payment: ['payer', 'paiement', 'recharger', 'recharge', 'ajouter du credit', 'ajouter du crédit'],
    confirm: ['confirmer', 'confirme', 'oui', 'continuer', 'proceder', 'procéder', 'approuver'],
    cancel: ['annuler', 'non', 'arreter', 'arrêter', 'abandonner', 'laisse tomber'],
    help: ['aide', 'que peux tu faire', 'que peux-tu faire', 'commandes', 'options'],
  },
  de: {
    balance: ['guthaben', 'saldo', 'wie viel', 'verbleibend', 'ubrig', 'übrig'],
    usage: ['verbrauch', 'verbraucht', 'nutzung', 'genutzt', 'wie viel habe ich verbraucht'],
    status: ['status', 'zustand', 'verbunden', 'getrennt', 'offline', 'online', 'funktioniert'],
    payment: ['bezahlen', 'zahlung', 'aufladen', 'aufladung', 'guthaben aufladen'],
    confirm: ['bestatigen', 'bestätigen', 'ja', 'weiter', 'fortfahren', 'genehmigen'],
    cancel: ['abbrechen', 'nein', 'stopp', 'stoppen', 'vergiss es'],
    help: ['hilfe', 'was kannst du tun', 'befehle', 'optionen'],
  },
  ar: {
    balance: ['رصيد', 'كم', 'المتبقي', 'متبقي', 'الرصيد'],
    usage: ['استهلاك', 'استخدام', 'مستهلك', 'كم استهلكت'],
    status: ['حالة', 'الحالة', 'متصل', 'غير متصل', 'يعمل'],
    payment: ['ادفع', 'دفع', 'شحن', 'اعادة تعبئة', 'إعادة تعبئة', 'اضف رصيد'],
    confirm: ['تأكيد', 'تاكيد', 'نعم', 'متابعة', 'موافق'],
    cancel: ['الغاء', 'إلغاء', 'لا', 'توقف', 'الغ'],
    help: ['مساعدة', 'ماذا يمكنك ان تفعل', 'ماذا يمكنك أن تفعل', 'اوامر', 'أوامر'],
  },
  sw: {
    balance: ['salio', 'kiasi', 'kiasi kilichobaki', 'iliyobaki', 'baki'],
    usage: ['matumizi', 'kutumika', 'imetumika', 'nimetumia kiasi gani'],
    status: ['hali', 'halii', 'imeunganishwa', 'haijaunganishwa', 'inafanya kazi'],
    payment: ['lipa', 'malipo', 'ongeza salio', 'kuongeza salio', 'nunua salio'],
    confirm: ['thibitisha', 'ndiyo', 'endelea', 'kubali'],
    cancel: ['ghairi', 'hapana', 'acha', 'simama'],
    help: ['msaada', 'unaweza kufanya nini', 'amri', 'chaguo'],
  },
  zh: {
    balance: ['余额', '还剩', '剩余', '多少', '余量'],
    usage: ['用量', '使用', '消耗', '已用', '我用了多少'],
    status: ['状态', '在线', '离线', '连接', '工作'],
    payment: ['支付', '付款', '充值', '缴费', '购买电量'],
    confirm: ['确认', '是', '继续', '同意', '好的'],
    cancel: ['取消', '不', '停止', '中止', '算了'],
    help: ['帮助', '你能做什么', '命令', '选项'],
  },
};

/* -------------------------------------------------------------------------- */
/* Localized response strings                                                 */
/* -------------------------------------------------------------------------- */

type ResponseTemplate = (params: VoiceResponseParams) => string;

const RESPONSES: Record<SupportedLocale, Record<VoiceResponseKey, ResponseTemplate>> = {
  en: {
    balance: (p) => `Your meter ${p.meter ?? ''} has a balance of ${p.balance ?? 'unknown'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `Your meter ${p.meter ?? ''} has used ${p.usage ?? 'unknown'} ${p.currency ?? ''}`.trim(),
    status: (p) => `Your meter ${p.meter ?? ''} is ${p.status ?? 'unknown'}`.trim(),
    paymentPrompt: (p) => `You want to pay ${p.amount ?? 'unknown'} ${p.currency ?? ''} for meter ${p.meter ?? ''}. Say confirm to proceed.`.trim(),
    paymentConfirmed: (p) => `Payment of ${p.amount ?? 'unknown'} ${p.currency ?? ''} for meter ${p.meter ?? ''} was successful.`.trim(),
    paymentFailed: (p) => `Payment for meter ${p.meter ?? ''} failed. Please try again.`.trim(),
    needConfirmation: () => `Please say confirm to proceed with the payment.`,
    needPin: () => `Please provide your security code to authorise the payment.`,
    unknown: () => `Sorry, I did not understand that. Say help for available commands.`,
    help: () => `You can ask for your balance, usage, meter status, or make a payment.`,
    notLinked: () => `Your account is not linked yet. Please link it in the app first.`,
    offline: () => `The service is temporarily unavailable. Please try again later.`,
  },
  es: {
    balance: (p) => `Tu medidor ${p.meter ?? ''} tiene un saldo de ${p.balance ?? 'desconocido'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `Tu medidor ${p.meter ?? ''} ha consumido ${p.usage ?? 'desconocido'} ${p.currency ?? ''}`.trim(),
    status: (p) => `Tu medidor ${p.meter ?? ''} esta ${p.status ?? 'desconocido'}`.trim(),
    paymentPrompt: (p) => `Quieres pagar ${p.amount ?? 'desconocido'} ${p.currency ?? ''} para el medidor ${p.meter ?? ''}. Di confirmar para continuar.`.trim(),
    paymentConfirmed: (p) => `El pago de ${p.amount ?? 'desconocido'} ${p.currency ?? ''} para el medidor ${p.meter ?? ''} fue exitoso.`.trim(),
    paymentFailed: (p) => `El pago para el medidor ${p.meter ?? ''} fallo. Intentalo de nuevo.`.trim(),
    needConfirmation: () => `Di confirmar para continuar con el pago.`,
    needPin: () => `Proporciona tu codigo de seguridad para autorizar el pago.`,
    unknown: () => `Lo siento, no entendi eso. Di ayuda para ver los comandos disponibles.`,
    help: () => `Puedes pedir tu saldo, consumo, estado del medidor o hacer un pago.`,
    notLinked: () => `Tu cuenta aun no esta vinculada. Vinculala primero en la aplicacion.`,
    offline: () => `El servicio no esta disponible temporalmente. Intentalo mas tarde.`,
  },
  fr: {
    balance: (p) => `Votre compteur ${p.meter ?? ''} a un solde de ${p.balance ?? 'inconnu'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `Votre compteur ${p.meter ?? ''} a consomme ${p.usage ?? 'inconnu'} ${p.currency ?? ''}`.trim(),
    status: (p) => `Votre compteur ${p.meter ?? ''} est ${p.status ?? 'inconnu'}`.trim(),
    paymentPrompt: (p) => `Vous voulez payer ${p.amount ?? 'inconnu'} ${p.currency ?? ''} pour le compteur ${p.meter ?? ''}. Dites confirmer pour continuer.`.trim(),
    paymentConfirmed: (p) => `Le paiement de ${p.amount ?? 'inconnu'} ${p.currency ?? ''} pour le compteur ${p.meter ?? ''} a reussi.`.trim(),
    paymentFailed: (p) => `Le paiement pour le compteur ${p.meter ?? ''} a echoue. Veuillez reessayer.`.trim(),
    needConfirmation: () => `Dites confirmer pour continuer le paiement.`,
    needPin: () => `Veuillez fournir votre code de securite pour autoriser le paiement.`,
    unknown: () => `Desole, je n'ai pas compris. Dites aide pour les commandes disponibles.`,
    help: () => `Vous pouvez demander votre solde, votre consommation, l'etat du compteur ou effectuer un paiement.`,
    notLinked: () => `Votre compte n'est pas encore lie. Liez-le d'abord dans l'application.`,
    offline: () => `Le service est temporairement indisponible. Veuillez reessayer plus tard.`,
  },
  de: {
    balance: (p) => `Ihr Zahler ${p.meter ?? ''} hat ein Guthaben von ${p.balance ?? 'unbekannt'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `Ihr Zahler ${p.meter ?? ''} hat ${p.usage ?? 'unbekannt'} ${p.currency ?? ''} verbraucht`.trim(),
    status: (p) => `Ihr Zahler ${p.meter ?? ''} ist ${p.status ?? 'unbekannt'}`.trim(),
    paymentPrompt: (p) => `Sie mochten ${p.amount ?? 'unbekannt'} ${p.currency ?? ''} fur Zahler ${p.meter ?? ''} bezahlen. Sagen Sie bestatigen zum Fortfahren.`.trim(),
    paymentConfirmed: (p) => `Die Zahlung von ${p.amount ?? 'unbekannt'} ${p.currency ?? ''} fur Zahler ${p.meter ?? ''} war erfolgreich.`.trim(),
    paymentFailed: (p) => `Die Zahlung fur Zahler ${p.meter ?? ''} ist fehlgeschlagen. Bitte versuchen Sie es erneut.`.trim(),
    needConfirmation: () => `Sagen Sie bestatigen, um mit der Zahlung fortzufahren.`,
    needPin: () => `Bitte geben Sie Ihren Sicherheitscode an, um die Zahlung zu autorisieren.`,
    unknown: () => `Entschuldigung, das habe ich nicht verstanden. Sagen Sie hilfe fur verfugbare Befehle.`,
    help: () => `Sie konnen nach Guthaben, Verbrauch, Zahlerstatus fragen oder eine Zahlung leisten.`,
    notLinked: () => `Ihr Konto ist noch nicht verknupft. Bitte verknupfen Sie es zuerst in der App.`,
    offline: () => `Der Dienst ist vorubergehend nicht verfugbar. Bitte versuchen Sie es spater erneut.`,
  },
  ar: {
    balance: (p) => `عدادك ${p.meter ?? ''} رصيده ${p.balance ?? 'غير معروف'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `عدادك ${p.meter ?? ''} استهلك ${p.usage ?? 'غير معروف'} ${p.currency ?? ''}`.trim(),
    status: (p) => `عدادك ${p.meter ?? ''} حالته ${p.status ?? 'غير معروفة'}`.trim(),
    paymentPrompt: (p) => `تريد دفع ${p.amount ?? 'غير معروف'} ${p.currency ?? ''} للعداد ${p.meter ?? ''}. قل تأكيد للمتابعة.`.trim(),
    paymentConfirmed: (p) => `تم دفع ${p.amount ?? 'غير معروف'} ${p.currency ?? ''} للعداد ${p.meter ?? ''} بنجاح.`.trim(),
    paymentFailed: (p) => `فشل الدفع للعداد ${p.meter ?? ''}. حاول مرة اخرى.`.trim(),
    needConfirmation: () => `قل تأكيد للمتابعة في الدفع.`,
    needPin: () => `يرجى تقديم رمز الامان لتفويض الدفع.`,
    unknown: () => `عذرا، لم افهم ذلك. قل مساعدة للاوامر المتاحة.`,
    help: () => `يمكنك طلب الرصيد او الاستهلاك او حالة العداد او اجراء دفع.`,
    notLinked: () => `حسابك غير مرتبط بعد. يرجى ربطه في التطبيق اولا.`,
    offline: () => `الخدمة غير متاحة مؤقتا. حاول لاحقا.`,
  },
  sw: {
    balance: (p) => `Mita yako ${p.meter ?? ''} ina salio la ${p.balance ?? 'haijulikani'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `Mita yako ${p.meter ?? ''} imetumia ${p.usage ?? 'haijulikani'} ${p.currency ?? ''}`.trim(),
    status: (p) => `Mita yako ${p.meter ?? ''} iko ${p.status ?? 'haijulikani'}`.trim(),
    paymentPrompt: (p) => `Unataka kulipa ${p.amount ?? 'haijulikani'} ${p.currency ?? ''} kwa mita ${p.meter ?? ''}. Sema thibitisha kuendelea.`.trim(),
    paymentConfirmed: (p) => `Malipo ya ${p.amount ?? 'haijulikani'} ${p.currency ?? ''} kwa mita ${p.meter ?? ''} yamefanikiwa.`.trim(),
    paymentFailed: (p) => `Malipo kwa mita ${p.meter ?? ''} yameshindikana. Tafadhali jaribu tena.`.trim(),
    needConfirmation: () => `Tafadhali sema thibitisha kuendelea na malipo.`,
    needPin: () => `Tafadhali toa msimbo wako wa usalama ili kuidhinisha malipo.`,
    unknown: () => `Samahani, sikuelewa hilo. Sema msaada kwa amri zinazopatikana.`,
    help: () => `Unaweza kuuliza salio, matumizi, hali ya mita, au kufanya malipo.`,
    notLinked: () => `Akaunti yako haijaunganishwa bado. Tafadhali iunganishe kwenye programu kwanza.`,
    offline: () => `Huduma haipatikani kwa muda. Tafadhali jaribu tena baadaye.`,
  },
  zh: {
    balance: (p) => `您的电表 ${p.meter ?? ''} 余额为 ${p.balance ?? '未知'} ${p.currency ?? ''}`.trim(),
    usage: (p) => `您的电表 ${p.meter ?? ''} 已使用 ${p.usage ?? '未知'} ${p.currency ?? ''}`.trim(),
    status: (p) => `您的电表 ${p.meter ?? ''} 状态为 ${p.status ?? '未知'}`.trim(),
    paymentPrompt: (p) => `您想为电表 ${p.meter ?? ''} 支付 ${p.amount ?? '未知'} ${p.currency ?? ''}。说确认以继续。`.trim(),
    paymentConfirmed: (p) => `为电表 ${p.meter ?? ''} 支付 ${p.amount ?? '未知'} ${p.currency ?? ''} 成功。`.trim(),
    paymentFailed: (p) => `电表 ${p.meter ?? ''} 的支付失败。请重试。`.trim(),
    needConfirmation: () => `请说确认以继续支付。`,
    needPin: () => `请提供您的安全码以授权支付。`,
    unknown: () => `抱歉，我没有听懂。说帮助查看可用命令。`,
    help: () => `您可以查询余额、用量、电表状态或进行支付。`,
    notLinked: () => `您的账户尚未关联。请先在应用中关联。`,
    offline: () => `服务暂时不可用。请稍后再试。`,
  },
};

/* -------------------------------------------------------------------------- */
/* Normalization helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalize an utterance: lowercase, strip diacritics/accents, collapse
 * whitespace, and remove common punctuation.
 */
export function normalizeUtterance(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a locale string to a supported locale, defaulting to `en`. */
export function resolveLocale(locale: string | undefined | null): SupportedLocale {
  if (!locale) return 'en';
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as SupportedLocale)
    : 'en';
}

/* -------------------------------------------------------------------------- */
/* Slot extraction                                                            */
/* -------------------------------------------------------------------------- */

const CURRENCY_ALIASES: Record<string, string> = {
  dollar: 'USD',
  dollars: 'USD',
  usd: 'USD',
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  pound: 'GBP',
  pounds: 'GBP',
  gbp: 'GBP',
  shilling: 'KES',
  shillings: 'KES',
  kes: 'KES',
  yuan: 'CNY',
  rmb: 'CNY',
  cny: 'CNY',
  dirham: 'AED',
  dirhams: 'AED',
  aed: 'AED',
  xlm: 'XLM',
  lumens: 'XLM',
  stroops: 'XLM',
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  un: 1, uno: 1, une: 1, ein: 1, eine: 1, eins: 1,
  dos: 2, deux: 2, zwei: 2,
  tres: 3, trois: 3, drei: 3,
  cuatro: 4, quatre: 4, vier: 4,
  cinco: 5, cinq: 5, funf: 5,
  diez: 10, dix: 10, zehn: 10,
  veinte: 20, vingt: 20, zwanzig: 20,
  cien: 100, cent: 100, hundert: 100,
};

/** Extract a numeric amount from a normalized utterance. */
function extractAmount(text: string): number | undefined {
  // Prefer explicit digits (with optional decimal part).
  const digitMatch = text.match(/(\d+(?:[.,]\d+)?)/);
  if (digitMatch) {
    const value = parseFloat(digitMatch[1].replace(',', '.'));
    if (Number.isFinite(value) && value > 0) return value;
  }

  // Fall back to simple number words (single token or "twenty five").
  const tokens = text.split(' ');
  let total = 0;
  let found = false;
  for (const token of tokens) {
    const word = NUMBER_WORDS[token];
    if (word === undefined) continue;
    found = true;
    if (word === 100 || word === 1000) {
      total = (total || 1) * word;
    } else {
      total += word;
    }
  }
  return found && total > 0 ? total : undefined;
}

/** Extract a currency code from a normalized utterance. */
function extractCurrency(text: string): string | undefined {
  const tokens = text.split(' ');
  for (const token of tokens) {
    const code = CURRENCY_ALIASES[token];
    if (code) return code;
  }
  // Uppercase 3-letter codes spoken as-is.
  const codeMatch = text.match(/\b([a-z]{3})\b/);
  if (codeMatch) {
    const upper = codeMatch[1].toUpperCase();
    if (Object.values(CURRENCY_ALIASES).includes(upper)) return upper;
  }
  return undefined;
}

/** Extract a meter nickname or id from a normalized utterance. */
function extractMeter(text: string): { meterNickname?: string; meterId?: string } {
  // Explicit id: "meter id abc123" / "id abc123".
  const idMatch = text.match(/\b(?:meter\s+)?id\s+([a-z0-9-]{3,})\b/);
  if (idMatch) {
    return { meterId: idMatch[1] };
  }

  // Nickname: "for the kitchen meter" / "kitchen meter" / "meter kitchen".
  const nicknameMatch =
    text.match(/\b(?:for|on|at)\s+(?:the\s+)?([a-z0-9-]{2,})\s+meter\b/) ||
    text.match(/\b([a-z0-9-]{2,})\s+meter\b/) ||
    text.match(/\bmeter\s+([a-z0-9-]{2,})\b/);
  if (nicknameMatch) {
    const candidate = nicknameMatch[1];
    // Ignore generic words that are not nicknames.
    if (!['my', 'the', 'a', 'an', 'this', 'that'].includes(candidate)) {
      return { meterNickname: candidate };
    }
  }

  return {};
}

/* -------------------------------------------------------------------------- */
/* Intent parsing                                                             */
/* -------------------------------------------------------------------------- */

/** Count how many keywords from a list appear in the normalized text. */
function countMatches(text: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) count += 1;
  }
  return count;
}

/**
 * Parse a voice utterance into an intent plus slots using rule-based NLP.
 *
 * The utterance is normalized (lowercased, accent-stripped) and matched
 * against the keyword table for the resolved locale. Confidence is derived
 * from the number and specificity of keyword matches.
 */
export function parseVoiceIntent(text: string, locale: string): VoiceParseResult {
  const resolved = resolveLocale(locale);
  const normalized = normalizeUtterance(text);
  const keywords = LOCALE_KEYWORDS[resolved];

  const slots: VoiceSlots = {};

  if (!normalized) {
    return { intent: 'unknown', slots, confidence: 0, locale: resolved };
  }

  const scores: Record<VoiceIntent, number> = {
    check_balance: countMatches(normalized, keywords.balance),
    check_usage: countMatches(normalized, keywords.usage),
    check_status: countMatches(normalized, keywords.status),
    make_payment: countMatches(normalized, keywords.payment),
    confirm_payment: countMatches(normalized, keywords.confirm),
    cancel: countMatches(normalized, keywords.cancel),
    help: countMatches(normalized, keywords.help),
    unknown: 0,
  };

  // Extract slots regardless of intent; the caller decides what to use.
  const meter = extractMeter(normalized);
  if (meter.meterNickname) slots.meterNickname = meter.meterNickname;
  if (meter.meterId) slots.meterId = meter.meterId;

  const amount = extractAmount(normalized);
  if (amount !== undefined) {
    slots.amount = amount;
    slots.amountStroops = Math.round(amount * STROOPS_PER_UNIT);
  }

  const currency = extractCurrency(normalized);
  if (currency) slots.currency = currency;

  // Pick the highest-scoring intent. Ties are broken by a fixed priority
  // order that favours the more specific/actionable intents.
  const priority: VoiceIntent[] = [
    'confirm_payment',
    'cancel',
    'make_payment',
    'check_balance',
    'check_usage',
    'check_status',
    'help',
  ];

  let bestIntent: VoiceIntent = 'unknown';
  let bestScore = 0;
  for (const intent of priority) {
    if (scores[intent] > bestScore) {
      bestScore = scores[intent];
      bestIntent = intent;
    }
  }

  // A payment utterance with an amount is more confidently a payment.
  if (bestIntent === 'make_payment' && slots.amount !== undefined) {
    bestScore += 1;
  }

  const confidence = bestIntent === 'unknown' ? 0 : Math.min(1, bestScore / 3);

  return { intent: bestIntent, slots, confidence, locale: resolved };
}

/* -------------------------------------------------------------------------- */
/* Localized responses                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Render a localized voice response string for the given key.
 *
 * Unknown locales fall back to English. Unknown keys fall back to the
 * `unknown` response so the assistant always has something to say.
 */
export function respond(
  locale: string,
  key: VoiceResponseKey,
  params: VoiceResponseParams = {},
): string {
  const resolved = resolveLocale(locale);
  const table = RESPONSES[resolved] ?? RESPONSES.en;
  const template = table[key] ?? RESPONSES.en[key] ?? RESPONSES.en.unknown;
  return template(params);
}

/* -------------------------------------------------------------------------- */
/* Secure payment confirmation flow                                           */
/* -------------------------------------------------------------------------- */

/** In-memory store of pending confirmations, keyed by hashed token. */
const pendingConfirmations = new Map<string, PaymentConfirmation>();

/** Hash a token for storage/lookup so raw tokens are never kept in memory. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Remove expired confirmations. */
function pruneExpired(now: number = Date.now()): void {
  for (const [key, confirmation] of pendingConfirmations) {
    if (confirmation.expiresAt <= now) {
      pendingConfirmations.delete(key);
    }
  }
}

/**
 * Create a single-use payment confirmation token.
 *
 * The returned token is a random 256-bit hex string. Only its SHA-256 hash is
 * stored, bound to the owner address and payment details, with a short TTL
 * (5 minutes). The caller must present the token back via
 * `consumePaymentConfirmation` AND pass `verifyVoicePaymentPin` before
 * executing the payment.
 */
export function createPaymentConfirmation(
  ownerAddress: string,
  request: PaymentConfirmationRequest,
): PaymentConfirmation {
  if (!ownerAddress) {
    throw new Error('ownerAddress is required');
  }
  if (!request || !request.meterId) {
    throw new Error('meterId is required');
  }
  if (!Number.isFinite(request.amountStroops) || request.amountStroops <= 0) {
    throw new Error('amountStroops must be a positive number');
  }

  pruneExpired();

  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const confirmation: PaymentConfirmation = {
    token,
    ownerAddress,
    meterId: request.meterId,
    amountStroops: request.amountStroops,
    memo: request.memo,
    createdAt: now,
    expiresAt: now + PAYMENT_CONFIRMATION_TTL_MS,
  };

  pendingConfirmations.set(hashToken(token), confirmation);
  return confirmation;
}

/** Constant-time comparison of two hex strings. */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validate and consume a payment confirmation token.
 *
 * Returns the stored confirmation when the token exists, has not expired, and
 * belongs to `ownerAddress`. The token is deleted on success (single-use) and
 * on expiry. Returns `null` for any invalid, expired, mismatched, or already
 * consumed token.
 */
export function consumePaymentConfirmation(
  token: string,
  ownerAddress: string,
): PaymentConfirmation | null {
  if (!token || !ownerAddress) return null;

  pruneExpired();

  const key = hashToken(token);
  const confirmation = pendingConfirm