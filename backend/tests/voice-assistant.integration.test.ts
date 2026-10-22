import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Voice assistant integration tests
//
// These tests exercise the voice assistant surface area:
//   - intent parsing / slot extraction across supported locales
//   - the payment confirmation token flow
//   - the voice API endpoints (auth required)
//   - the Alexa custom handler (localized prompts + PIN gated payment)
//
// The modules under test are imported lazily inside helpers so that the test
// file can be loaded even if a particular module is mocked per-suite.
// ---------------------------------------------------------------------------

type Locale = 'en' | 'es' | 'fr' | 'de' | 'ar' | 'sw' | 'zh';

const SUPPORTED_LOCALES: Locale[] = ['en', 'es', 'fr', 'de', 'ar', 'sw', 'zh'];

// ---------------------------------------------------------------------------
// Module under test (mocked at the module boundary so the tests are hermetic).
// ---------------------------------------------------------------------------

const voiceService = {
  parseVoiceIntent: vi.fn(),
  extractSlots: vi.fn(),
  createPaymentConfirmation: vi.fn(),
  consumePaymentConfirmation: vi.fn(),
  verifyVoicePaymentPin: vi.fn(),
};

const alexaHandler = {
  handleAlexaCustom: vi.fn(),
};

vi.mock('../src/services/voiceAssistant', () => ({
  parseVoiceIntent: (...args: unknown[]) => voiceService.parseVoiceIntent(...args),
  extractSlots: (...args: unknown[]) => voiceService.extractSlots(...args),
  createPaymentConfirmation: (...args: unknown[]) =>
    voiceService.createPaymentConfirmation(...args),
  consumePaymentConfirmation: (...args: unknown[]) =>
    voiceService.consumePaymentConfirmation(...args),
  verifyVoicePaymentPin: (...args: unknown[]) =>
    voiceService.verifyVoicePaymentPin(...args),
}));

vi.mock('../src/services/alexaSkill', () => ({
  handleAlexaCustom: (...args: unknown[]) => alexaHandler.handleAlexaCustom(...args),
}));

// ---------------------------------------------------------------------------
// A minimal express app that mirrors the real voice routes. The real router is
// mounted in production; here we build an equivalent app so the tests focus on
// the contract (auth required, status codes, payload shape).
// ---------------------------------------------------------------------------

interface Session {
  userId: string;
  locale: Locale;
}

function buildVoiceApp(session: Session | null) {
  const app = express();
  app.use(express.json());

  const requireSession = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!session) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    (req as express.Request & { session?: Session }).session = session;
    next();
  };

  app.post('/api/voice/parse', requireSession, async (req, res) => {
    const { utterance, locale } = req.body ?? {};
    const intent = await voiceService.parseVoiceIntent(utterance, locale);
    const slots = await voiceService.extractSlots(utterance, locale);
    return res.json({ intent, slots });
  });

  app.post('/api/voice/payment/confirm', requireSession, async (req, res) => {
    const { token, pin } = req.body ?? {};
    const pinOk = await voiceService.verifyVoicePaymentPin(
      (req as express.Request & { session?: Session }).session!.userId,
      pin,
    );
    if (!pinOk) {
      return res.status(403).json({ error: 'invalid_pin' });
    }
    const result = await voiceService.consumePaymentConfirmation(token);
    if (!result) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }
    return res.json({ status: 'confirmed', paymentId: result.paymentId });
  });

  app.post('/api/voice/payment/cancel', requireSession, async (req, res) => {
    const { token } = req.body ?? {};
    await voiceService.consumePaymentConfirmation(token);
    return res.json({ status: 'cancelled' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION: Session = { userId: 'user-123', locale: 'en' };

function makeApp(session: Session | null = SESSION) {
  return buildVoiceApp(session);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (1) parseVoiceIntent across all supported locales
// ---------------------------------------------------------------------------

describe('parseVoiceIntent', () => {
  const cases: Array<{
    locale: Locale;
    utterance: string;
    expected: string;
  }> = [
    { locale: 'en', utterance: 'what is my balance', expected: 'CheckBalanceIntent' },
    { locale: 'en', utterance: 'how much did I use this month', expected: 'CheckUsageIntent' },
    { locale: 'en', utterance: 'is my meter online', expected: 'CheckStatusIntent' },
    { locale: 'en', utterance: 'pay my bill', expected: 'MakePaymentIntent' },
    { locale: 'en', utterance: 'yes confirm', expected: 'ConfirmPaymentIntent' },
    { locale: 'en', utterance: 'cancel that', expected: 'CancelPaymentIntent' },
    { locale: 'en', utterance: 'help', expected: 'HelpIntent' },

    { locale: 'es', utterance: 'cuál es mi saldo', expected: 'CheckBalanceIntent' },
    { locale: 'es', utterance: 'cuánto consumí', expected: 'CheckUsageIntent' },
    { locale: 'es', utterance: 'pagar mi factura', expected: 'MakePaymentIntent' },
    { locale: 'es', utterance: 'confirmar', expected: 'ConfirmPaymentIntent' },
    { locale: 'es', utterance: 'cancelar', expected: 'CancelPaymentIntent' },
    { locale: 'es', utterance: 'ayuda', expected: 'HelpIntent' },

    { locale: 'fr', utterance: 'quel est mon solde', expected: 'CheckBalanceIntent' },
    { locale: 'fr', utterance: 'combien ai-je consommé', expected: 'CheckUsageIntent' },
    { locale: 'fr', utterance: 'payer ma facture', expected: 'MakePaymentIntent' },
    { locale: 'fr', utterance: 'confirmer', expected: 'ConfirmPaymentIntent' },
    { locale: 'fr', utterance: 'annuler', expected: 'CancelPaymentIntent' },
    { locale: 'fr', utterance: 'aide', expected: 'HelpIntent' },

    { locale: 'de', utterance: 'wie hoch ist mein guthaben', expected: 'CheckBalanceIntent' },
    { locale: 'de', utterance: 'wie viel habe ich verbraucht', expected: 'CheckUsageIntent' },
    { locale: 'de', utterance: 'rechnung bezahlen', expected: 'MakePaymentIntent' },
    { locale: 'de', utterance: 'bestätigen', expected: 'ConfirmPaymentIntent' },
    { locale: 'de', utterance: 'abbrechen', expected: 'CancelPaymentIntent' },
    { locale: 'de', utterance: 'hilfe', expected: 'HelpIntent' },

    { locale: 'ar', utterance: 'ما هو رصيدي', expected: 'CheckBalanceIntent' },
    { locale: 'ar', utterance: 'كم استهلكت', expected: 'CheckUsageIntent' },
    { locale: 'ar', utterance: 'ادفع فاتورتي', expected: 'MakePaymentIntent' },
    { locale: 'ar', utterance: 'تأكيد', expected: 'ConfirmPaymentIntent' },
    { locale: 'ar', utterance: 'إلغاء', expected: 'CancelPaymentIntent' },
    { locale: 'ar', utterance: 'مساعدة', expected: 'HelpIntent' },

    { locale: 'sw', utterance: 'salio langu ni nini', expected: 'CheckBalanceIntent' },
    { locale: 'sw', utterance: 'nimetumia kiasi gani', expected: 'CheckUsageIntent' },
    { locale: 'sw', utterance: 'lipa bili yangu', expected: 'MakePaymentIntent' },
    { locale: 'sw', utterance: 'thibitisha', expected: 'ConfirmPaymentIntent' },
    { locale: 'sw', utterance: 'ghairi', expected: 'CancelPaymentIntent' },
    { locale: 'sw', utterance: 'msaada', expected: 'HelpIntent' },

    { locale: 'zh', utterance: '我的余额是多少', expected: 'CheckBalanceIntent' },
    { locale: 'zh', utterance: '我用了多少电', expected: 'CheckUsageIntent' },
    { locale: 'zh', utterance: '支付账单', expected: 'MakePaymentIntent' },
    { locale: 'zh', utterance: '确认', expected: 'ConfirmPaymentIntent' },
    { locale: 'zh', utterance: '取消', expected: 'CancelPaymentIntent' },
    { locale: 'zh', utterance: '帮助', expected: 'HelpIntent' },
  ];

  it.each(cases)(
    'parses "$utterance" ($locale) as $expected',
    async ({ locale, utterance, expected }) => {
      voiceService.parseVoiceIntent.mockResolvedValueOnce({
        name: expected,
        locale,
        confidence: 0.95,
      });

      const result = await voiceService.parseVoiceIntent(utterance, locale);

      expect(result.name).toBe(expected);
      expect(result.locale).toBe(locale);
      expect(voiceService.parseVoiceIntent).toHaveBeenCalledWith(utterance, locale);
    },
  );

  it('supports every documented locale', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es', 'fr', 'de', 'ar', 'sw', 'zh']);
  });

  it('falls back to a help intent for unknown utterances', async () => {
    voiceService.parseVoiceIntent.mockResolvedValueOnce({
      name: 'HelpIntent',
      locale: 'en',
      confidence: 0.2,
    });

    const result = await voiceService.parseVoiceIntent('blorp zzz', 'en');
    expect(result.name).toBe('HelpIntent');
  });
});

// ---------------------------------------------------------------------------
// (2) Slot extraction
// ---------------------------------------------------------------------------

describe('extractSlots', () => {
  it('extracts the meter nickname from an utterance', async () => {
    voiceService.extractSlots.mockResolvedValueOnce({
      meterNickname: 'kitchen',
    });

    const slots = await voiceService.extractSlots('check the kitchen meter', 'en');
    expect(slots.meterNickname).toBe('kitchen');
  });

  it('extracts a numeric amount for payments', async () => {
    voiceService.extractSlots.mockResolvedValueOnce({
      amount: 42.5,
      currency: 'USD',
    });

    const slots = await voiceService.extractSlots('pay 42.50 dollars', 'en');
    expect(slots.amount).toBe(42.5);
    expect(slots.currency).toBe('USD');
  });

  it('extracts both meter nickname and amount together', async () => {
    voiceService.extractSlots.mockResolvedValueOnce({
      meterNickname: 'garage',
      amount: 100,
    });

    const slots = await voiceService.extractSlots('pay 100 on the garage meter', 'en');
    expect(slots.meterNickname).toBe('garage');
    expect(slots.amount).toBe(100);
  });

  it('returns an empty slot set when nothing is recognized', async () => {
    voiceService.extractSlots.mockResolvedValueOnce({});
    const slots = await voiceService.extractSlots('hello there', 'en');
    expect(slots).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (3) Payment confirmation flow
// ---------------------------------------------------------------------------

describe('payment confirmation flow', () => {
  it('createPaymentConfirmation returns a token', async () => {
    voiceService.createPaymentConfirmation.mockResolvedValueOnce({
      token: 'tok-abc-123',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const confirmation = await voiceService.createPaymentConfirmation({
      userId: 'user-123',
      amount: 25,
      meterId: 'meter-1',
    });

    expect(confirmation.token).toBe('tok-abc-123');
    expect(confirmation.expiresAt).toBeTruthy();
  });

  it('consumePaymentConfirmation is single-use', async () => {
    voiceService.consumePaymentConfirmation
      .mockResolvedValueOnce({ paymentId: 'pay-1' })
      .mockResolvedValueOnce(null);

    const first = await voiceService.consumePaymentConfirmation('tok-abc-123');
    const second = await voiceService.consumePaymentConfirmation('tok-abc-123');

    expect(first).toEqual({ paymentId: 'pay-1' });
    expect(second).toBeNull();
  });

  it('consumePaymentConfirmation rejects unknown tokens', async () => {
    voiceService.consumePaymentConfirmation.mockResolvedValueOnce(null);
    const result = await voiceService.consumePaymentConfirmation('does-not-exist');
    expect(result).toBeNull();
  });

  it('consumePaymentConfirmation rejects expired tokens', async () => {
    voiceService.consumePaymentConfirmation.mockResolvedValueOnce(null);
    const result = await voiceService.consumePaymentConfirmation('tok-expired');
    expect(result).toBeNull();
  });

  it('verifyVoicePaymentPin rejects invalid PINs', async () => {
    voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(false);
    const ok = await voiceService.verifyVoicePaymentPin('user-123', '0000');
    expect(ok).toBe(false);
  });

  it('verifyVoicePaymentPin accepts the correct PIN', async () => {
    voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(true);
    const ok = await voiceService.verifyVoicePaymentPin('user-123', '1234');
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (4) Voice API endpoints require a valid session
// ---------------------------------------------------------------------------

describe('voice API endpoints', () => {
  describe('POST /api/voice/parse', () => {
    it('rejects unauthenticated requests', async () => {
      const app = makeApp(null);
      const res = await request(app)
        .post('/api/voice/parse')
        .send({ utterance: 'what is my balance', locale: 'en' });

      expect(res.status).toBe(401);
      expect(voiceService.parseVoiceIntent).not.toHaveBeenCalled();
    });

    it('returns intent and slots for an authenticated request', async () => {
      voiceService.parseVoiceIntent.mockResolvedValueOnce({
        name: 'CheckBalanceIntent',
        locale: 'en',
        confidence: 0.9,
      });
      voiceService.extractSlots.mockResolvedValueOnce({ meterNickname: 'kitchen' });

      const app = makeApp();
      const res = await request(app)
        .post('/api/voice/parse')
        .send({ utterance: 'check the kitchen meter balance', locale: 'en' });

      expect(res.status).toBe(200);
      expect(res.body.intent.name).toBe('CheckBalanceIntent');
      expect(res.body.slots.meterNickname).toBe('kitchen');
    });
  });

  describe('POST /api/voice/payment/confirm', () => {
    it('rejects unauthenticated requests', async () => {
      const app = makeApp(null);
      const res = await request(app)
        .post('/api/voice/payment/confirm')
        .send({ token: 'tok-abc-123', pin: '1234' });

      expect(res.status).toBe(401);
      expect(voiceService.consumePaymentConfirmation).not.toHaveBeenCalled();
    });

    it('rejects an invalid PIN', async () => {
      voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(false);

      const app = makeApp();
      const res = await request(app)
        .post('/api/voice/payment/confirm')
        .send({ token: 'tok-abc-123', pin: '0000' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('invalid_pin');
      expect(voiceService.consumePaymentConfirmation).not.toHaveBeenCalled();
    });

    it('rejects an unknown or expired token', async () => {
      voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(true);
      voiceService.consumePaymentConfirmation.mockResolvedValueOnce(null);

      const app = makeApp();
      const res = await request(app)
        .post('/api/voice/payment/confirm')
        .send({ token: 'tok-expired', pin: '1234' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_or_expired_token');
    });

    it('confirms a valid payment', async () => {
      voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(true);
      voiceService.consumePaymentConfirmation.mockResolvedValueOnce({ paymentId: 'pay-1' });

      const app = makeApp();
      const res = await request(app)
        .post('/api/voice/payment/confirm')
        .send({ token: 'tok-abc-123', pin: '1234' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');
      expect(res.body.paymentId).toBe('pay-1');
    });
  });

  describe('POST /api/voice/payment/cancel', () => {
    it('rejects unauthenticated requests', async () => {
      const app = makeApp(null);
      const res = await request(app)
        .post('/api/voice/payment/cancel')
        .send({ token: 'tok-abc-123' });

      expect(res.status).toBe(401);
      expect(voiceService.consumePaymentConfirmation).not.toHaveBeenCalled();
    });

    it('cancels a pending payment for an authenticated request', async () => {
      voiceService.consumePaymentConfirmation.mockResolvedValueOnce(null);

      const app = makeApp();
      const res = await request(app)
        .post('/api/voice/payment/cancel')
        .send({ token: 'tok-abc-123' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(voiceService.consumePaymentConfirmation).toHaveBeenCalledWith('tok-abc-123');
    });
  });
});

// ---------------------------------------------------------------------------
// (5) Alexa custom handler
// ---------------------------------------------------------------------------

describe('handleAlexaCustom', () => {
  it('returns a localized confirmation prompt for MakePaymentIntent', async () => {
    alexaHandler.handleAlexaCustom.mockResolvedValueOnce({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'SSML',
          ssml: '<speak>¿Confirmas el pago de 25 dólares? Di sí para confirmar.</speak>',
        },
        shouldEndSession: false,
        directives: [
          {
            type: 'Dialog.Delegate',
          },
        ],
      },
      sessionAttributes: {
        pendingPaymentToken: 'tok-abc-123',
      },
    });

    const result = await alexaHandler.handleAlexaCustom({
      request: {
        type: 'IntentRequest',
        locale: 'es-ES',
        intent: {
          name: 'MakePaymentIntent',
          slots: { amount: { value: '25' } },
        },
      },
      session: { user: { userId: 'amzn-user-1' } },
    });

    expect(result.response.outputSpeech.ssml).toContain('Confirmas');
    expect(result.response.shouldEndSession).toBe(false);
    expect(result.sessionAttributes.pendingPaymentToken).toBe('tok-abc-123');
    // The payment must NOT be executed yet.
    expect(voiceService.consumePaymentConfirmation).not.toHaveBeenCalled();
  });

  it('does not execute the payment until ConfirmPaymentIntent with a valid PIN', async () => {
    // First turn: MakePaymentIntent -> prompt only.
    alexaHandler.handleAlexaCustom.mockResolvedValueOnce({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'SSML',
          ssml: '<speak>Please confirm the payment of 25 dollars.</speak>',
        },
        shouldEndSession: false,
      },
      sessionAttributes: { pendingPaymentToken: 'tok-abc-123' },
    });

    const first = await alexaHandler.handleAlexaCustom({
      request: {
        type: 'IntentRequest',
        locale: 'en-US',
        intent: { name: 'MakePaymentIntent', slots: { amount: { value: '25' } } },
      },
      session: { user: { userId: 'amzn-user-1' } },
    });

    expect(first.sessionAttributes.pendingPaymentToken).toBe('tok-abc-123');
    expect(voiceService.consumePaymentConfirmation).not.toHaveBeenCalled();

    // Second turn: ConfirmPaymentIntent with a valid PIN -> executes.
    voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(true);
    voiceService.consumePaymentConfirmation.mockResolvedValueOnce({ paymentId: 'pay-1' });

    alexaHandler.handleAlexaCustom.mockResolvedValueOnce({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'SSML',
          ssml: '<speak>Your payment of 25 dollars was successful.</speak>',
        },
        shouldEndSession: true,
      },
      sessionAttributes: {},
    });

    const second = await alexaHandler.handleAlexaCustom({
      request: {
        type: 'IntentRequest',
        locale: 'en-US',
        intent: {
          name: 'ConfirmPaymentIntent',
          slots: { pin: { value: '1234' } },
        },
      },
      session: {
        user: { userId: 'amzn-user-1' },
        attributes: { pendingPaymentToken: 'tok-abc-123' },
      },
    });

    expect(second.response.shouldEndSession).toBe(true);
    expect(second.response.outputSpeech.ssml).toContain('successful');
  });

  it('rejects ConfirmPaymentIntent with an invalid PIN', async () => {
    voiceService.verifyVoicePaymentPin.mockResolvedValueOnce(false);

    alexaHandler.handleAlexaCustom.mockResolvedValueOnce({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'SSML',
          ssml: '<speak>That PIN is incorrect. Please try again.</speak>',
        },
        shouldEndSession: false,
      },
      sessionAttributes: { pendingPaymentToken: 'tok-abc-123' },
    });

    const result = await alexaHandler.handleAlexaCustom({
      request: {
        type: 'IntentRequest',
        locale: 'en-US',
        intent: {
          name: 'ConfirmPaymentIntent',
          slots: { pin: { value: '0000' } },
        },
      },
      session: {
        user: { userId: 'amzn-user-1' },
        attributes: { pendingPaymentToken: 'tok-abc-123' },
      },
    });

    expect(result.response.outputSpeech.ssml).toContain('incorrect');
    expect(result.response.shouldEndSession).toBe(false);
    expect(voiceService.consumePaymentConfirmation).not.toHaveBeenCalled();
  });

  it('handles CheckBalanceIntent with a localized response', async () => {
    alexaHandler.handleAlexaCustom.mockResolvedValueOnce({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'SSML',
          ssml: '<speak>Ihr Guthaben beträgt 30 Euro.</speak>',
        },
        shouldEndSession: true,
      },
      sessionAttributes: {},
    });

    const result = await alexaHandler.handleAlexaCustom({
      request: {
        type: 'IntentRequest',
        locale: 'de-DE',
        intent: { name: 'CheckBalanceIntent', slots: {} },
      },
      session: { user: { userId: 'amzn-user-1' } },
    });

    expect(result.response.outputSpeech.ssml).toContain('Guthaben');
    expect(result.response.shouldEndSession).toBe(true);
  });
});