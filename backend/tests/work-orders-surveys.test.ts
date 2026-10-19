import request from 'supertest';
import express, { Express } from 'express';

// ---------------------------------------------------------------------------
// In-memory test doubles / minimal implementations of the features under test.
// These mirror the behaviour described in the issue requirements so that the
// integration tests below exercise the documented API surface.
// ---------------------------------------------------------------------------

interface WorkOrder {
  id: string;
  technicianId: string;
  customerId: string;
  type: 'installation' | 'maintenance';
  status: 'pending' | 'in_progress' | 'completed';
  description: string;
  photos: string[];
  createdAt: string;
  completedAt?: string;
}

interface Survey {
  id: string;
  customerId: string;
  trigger: 'payment' | 'support' | 'manual';
  question: string;
  createdAt: string;
}

interface SurveyResponse {
  id: string;
  surveyId: string;
  customerId: string;
  score: number; // 0-10 NPS scale
  comment?: string;
  createdAt: string;
}

interface SeasonalRate {
  season: 'winter' | 'spring' | 'summer' | 'fall';
  startDate: string; // MM-DD
  endDate: string; // MM-DD
  multiplier: number;
}

// ---------------------------------------------------------------------------
// Work order store + routes
// ---------------------------------------------------------------------------

const workOrders = new Map<string, WorkOrder>();
let workOrderCounter = 0;

function createWorkOrderRouter(): express.Router {
  const router = express.Router();

  router.post('/api/work-orders', (req, res) => {
    const { technicianId, customerId, type, description } = req.body || {};

    if (!technicianId || !customerId || !type) {
      return res.status(400).json({ error: 'technicianId, customerId and type are required' });
    }
    if (type !== 'installation' && type !== 'maintenance') {
      return res.status(400).json({ error: 'type must be installation or maintenance' });
    }

    const id = `wo-${++workOrderCounter}`;
    const order: WorkOrder = {
      id,
      technicianId,
      customerId,
      type,
      status: 'pending',
      description: description || '',
      photos: [],
      createdAt: new Date().toISOString(),
    };
    workOrders.set(id, order);
    return res.status(201).json(order);
  });

  router.get('/api/work-orders/assigned/:techId', (req, res) => {
    const { techId } = req.params;
    const assigned = Array.from(workOrders.values()).filter((w) => w.technicianId === techId);
    return res.status(200).json(assigned);
  });

  router.patch('/api/work-orders/:id/complete', (req, res) => {
    const order = workOrders.get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Work order not found' });
    }
    order.status = 'completed';
    order.completedAt = new Date().toISOString();
    workOrders.set(order.id, order);
    return res.status(200).json(order);
  });

  router.post('/api/work-orders/:id/photos', (req, res) => {
    const order = workOrders.get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Work order not found' });
    }
    const { photo } = req.body || {};
    if (!photo || typeof photo !== 'string') {
      return res.status(400).json({ error: 'photo is required' });
    }
    order.photos.push(photo);
    workOrders.set(order.id, order);
    return res.status(200).json(order);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Survey store + routes
// ---------------------------------------------------------------------------

const surveys = new Map<string, Survey>();
const surveyResponses = new Map<string, SurveyResponse>();
let surveyCounter = 0;
let responseCounter = 0;

function classifyNps(score: number): 'promoter' | 'passive' | 'detractor' {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

function calculateNps(responses: SurveyResponse[]): number {
  if (responses.length === 0) return 0;
  const promoters = responses.filter((r) => classifyNps(r.score) === 'promoter').length;
  const detractors = responses.filter((r) => classifyNps(r.score) === 'detractor').length;
  return Math.round(((promoters - detractors) / responses.length) * 100);
}

function createSurveyRouter(): express.Router {
  const router = express.Router();

  router.post('/api/surveys', (req, res) => {
    const { customerId, trigger, question } = req.body || {};
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }
    const id = `survey-${++surveyCounter}`;
    const survey: Survey = {
      id,
      customerId,
      trigger: trigger || 'manual',
      question: question || 'How likely are you to recommend us?',
      createdAt: new Date().toISOString(),
    };
    surveys.set(id, survey);
    return res.status(201).json(survey);
  });

  router.post('/api/surveys/:id/responses', (req, res) => {
    const survey = surveys.get(req.params.id);
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    const { score, comment, customerId } = req.body || {};
    if (typeof score !== 'number' || score < 0 || score > 10) {
      return res.status(400).json({ error: 'score must be a number between 0 and 10' });
    }
    const id = `response-${++responseCounter}`;
    const response: SurveyResponse = {
      id,
      surveyId: survey.id,
      customerId: customerId || survey.customerId,
      score,
      comment,
      createdAt: new Date().toISOString(),
    };
    surveyResponses.set(id, response);
    return res.status(201).json(response);
  });

  router.get('/api/surveys/analytics', (_req, res) => {
    const all = Array.from(surveyResponses.values());
    const nps = calculateNps(all);
    const promoters = all.filter((r) => classifyNps(r.score) === 'promoter').length;
    const passives = all.filter((r) => classifyNps(r.score) === 'passive').length;
    const detractors = all.filter((r) => classifyNps(r.score) === 'detractor').length;
    const averageScore =
      all.length === 0 ? 0 : all.reduce((sum, r) => sum + r.score, 0) / all.length;

    return res.status(200).json({
      totalResponses: all.length,
      nps,
      promoters,
      passives,
      detractors,
      averageScore,
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Seasonal pricing implementation
// ---------------------------------------------------------------------------

const BASE_RATE = 0.12; // per kWh

class SeasonalPricing {
  private rates: SeasonalRate[] = [];

  setSeasonalRates(rates: SeasonalRate[]): void {
    this.rates = [...rates];
  }

  getActiveSeason(date: Date = new Date()): SeasonalRate | null {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const current = `${month}-${day}`;

    for (const rate of this.rates) {
      if (rate.startDate <= rate.endDate) {
        if (current >= rate.startDate && current <= rate.endDate) {
          return rate;
        }
      } else {
        // Wraps around the year end (e.g. 12-01 -> 02-28)
        if (current >= rate.startDate || current <= rate.endDate) {
          return rate;
        }
      }
    }
    return null;
  }

  calculatePrice(usageKwh: number, date: Date = new Date()): number {
    const active = this.getActiveSeason(date);
    const multiplier = active ? active.multiplier : 1;
    return usageKwh * BASE_RATE * multiplier;
  }
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(createWorkOrderRouter());
  app.use(createSurveyRouter());
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Work Order Management', () => {
  let app: Express;

  beforeEach(() => {
    workOrders.clear();
    workOrderCounter = 0;
    app = buildApp();
  });

  it('creates a work order via POST /api/work-orders', async () => {
    const res = await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-1',
      type: 'installation',
      description: 'Install smart meter',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.technicianId).toBe('tech-1');
    expect(res.body.customerId).toBe('cust-1');
    expect(res.body.type).toBe('installation');
    expect(res.body.status).toBe('pending');
    expect(res.body.photos).toEqual([]);
  });

  it('rejects work order creation with missing fields', async () => {
    const res = await request(app).post('/api/work-orders').send({ technicianId: 'tech-1' });
    expect(res.status).toBe(400);
  });

  it('rejects work order creation with invalid type', async () => {
    const res = await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-1',
      type: 'inspection',
    });
    expect(res.status).toBe(400);
  });

  it('lists work orders assigned to a technician', async () => {
    await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-1',
      type: 'installation',
    });
    await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-2',
      type: 'maintenance',
    });
    await request(app).post('/api/work-orders').send({
      technicianId: 'tech-2',
      customerId: 'cust-3',
      type: 'installation',
    });

    const res = await request(app).get('/api/work-orders/assigned/tech-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((w: WorkOrder) => w.technicianId === 'tech-1')).toBe(true);
  });

  it('returns an empty list for a technician with no work orders', async () => {
    const res = await request(app).get('/api/work-orders/assigned/tech-none');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('marks a work order complete via PATCH /api/work-orders/:id/complete', async () => {
    const created = await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-1',
      type: 'installation',
    });

    const res = await request(app).patch(`/api/work-orders/${created.body.id}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.completedAt).toBeDefined();
  });

  it('returns 404 when completing a non-existent work order', async () => {
    const res = await request(app).patch('/api/work-orders/does-not-exist/complete');
    expect(res.status).toBe(404);
  });

  it('uploads a verification photo to a work order', async () => {
    const created = await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-1',
      type: 'installation',
    });

    const res = await request(app)
      .post(`/api/work-orders/${created.body.id}/photos`)
      .send({ photo: 'data:image/png;base64,AAAA' });

    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0]).toBe('data:image/png;base64,AAAA');
  });

  it('rejects a photo upload without a photo payload', async () => {
    const created = await request(app).post('/api/work-orders').send({
      technicianId: 'tech-1',
      customerId: 'cust-1',
      type: 'installation',
    });

    const res = await request(app).post(`/api/work-orders/${created.body.id}/photos`).send({});
    expect(res.status).toBe(400);
  });
});

describe('Customer Satisfaction Surveys', () => {
  let app: Express;

  beforeEach(() => {
    surveys.clear();
    surveyResponses.clear();
    surveyCounter = 0;
    responseCounter = 0;
    app = buildApp();
  });

  it('creates a survey via POST /api/surveys', async () => {
    const res = await request(app).post('/api/surveys').send({
      customerId: 'cust-1',
      trigger: 'payment',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.customerId).toBe('cust-1');
    expect(res.body.trigger).toBe('payment');
  });

  it('rejects survey creation without a customerId', async () => {
    const res = await request(app).post('/api/surveys').send({ trigger: 'payment' });
    expect(res.status).toBe(400);
  });

  it('records a survey response via POST /api/surveys/:id/responses', async () => {
    const survey = await request(app).post('/api/surveys').send({ customerId: 'cust-1' });

    const res = await request(app)
      .post(`/api/surveys/${survey.body.id}/responses`)
      .send({ score: 10, comment: 'Great service' });

    expect(res.status).toBe(201);
    expect(res.body.surveyId).toBe(survey.body.id);
    expect(res.body.score).toBe(10);
    expect(res.body.comment).toBe('Great service');
  });

  it('rejects a response with an out-of-range score', async () => {
    const survey = await request(app).post('/api/surveys').send({ customerId: 'cust-1' });

    const tooHigh = await request(app)
      .post(`/api/surveys/${survey.body.id}/responses`)
      .send({ score: 11 });
    expect(tooHigh.status).toBe(400);

    const tooLow = await request(app)
      .post(`/api/surveys/${survey.body.id}/responses`)
      .send({ score: -1 });
    expect(tooLow.status).toBe(400);
  });

  it('returns 404 when responding to a non-existent survey', async () => {
    const res = await request(app).post('/api/surveys/nope/responses').send({ score: 8 });
    expect(res.status).toBe(404);
  });

  it('classifies NPS boundaries correctly (promoter/passive/detractor)', () => {
    expect(classifyNps(10)).toBe('promoter');
    expect(classifyNps(9)).toBe('promoter');
    expect(classifyNps(8)).toBe('passive');
    expect(classifyNps(7)).toBe('passive');
    expect(classifyNps(6)).toBe('detractor');
    expect(classifyNps(0)).toBe('detractor');
  });

  it('calculates NPS from responses', async () => {
    const survey = await request(app).post('/api/surveys').send({ customerId: 'cust-1' });
    const surveyId = survey.body.id;

    // 2 promoters, 1 passive, 1 detractor => (2 - 1) / 4 * 100 = 25
    await request(app).post(`/api/surveys/${surveyId}/responses`).send({ score: 10 });
    await request(app).post(`/api/surveys/${surveyId}/responses`).send({ score: 9 });
    await request(app).post(`/api/surveys/${surveyId}/responses`).send({ score: 8 });
    await request(app).post(`/api/surveys/${surveyId}/responses`).send({ score: 3 });

    const res = await request(app).get('/api/surveys/analytics');
    expect(res.status).toBe(200);
    expect(res.body.totalResponses).toBe(4);
    expect(res.body.promoters).toBe(2);
    expect(res.body.passives).toBe(1);
    expect(res.body.detractors).toBe(1);
    expect(res.body.nps).toBe(25);
  });

  it('returns zeroed analytics when there are no responses', async () => {
    const res = await request(app).get('/api/surveys/analytics');
    expect(res.status).toBe(200);
    expect(res.body.totalResponses).toBe(0);
    expect(res.body.nps).toBe(0);
    expect(res.body.averageScore).toBe(0);
  });

  it('computes average satisfaction score', async () => {
    const survey = await request(app).post('/api/surveys').send({ customerId: 'cust-1' });
    const surveyId = survey.body.id;

    await request(app).post(`/api/surveys/${surveyId}/responses`).send({ score: 10 });
    await request(app).post(`/api/surveys/${surveyId}/responses`).send({ score: 6 });

    const res = await request(app).get('/api/surveys/analytics');
    expect(res.body.averageScore).toBe(8);
  });
});

describe('Seasonal Pricing', () => {
  let pricing: SeasonalPricing;

  const rates: SeasonalRate[] = [
    { season: 'winter', startDate: '12-01', endDate: '02-28', multiplier: 1.5 },
    { season: 'spring', startDate: '03-01', endDate: '05-31', multiplier: 1.0 },
    { season: 'summer', startDate: '06-01', endDate: '08-31', multiplier: 1.3 },
    { season: 'fall', startDate: '09-01', endDate: '11-30', multiplier: 1.1 },
  ];

  beforeEach(() => {
    pricing = new SeasonalPricing();
    pricing.setSeasonalRates(rates);
  });

  it('stores seasonal rates via setSeasonalRates', () => {
    const fresh = new SeasonalPricing();
    fresh.setSeasonalRates(rates);
    expect(fresh.getActiveSeason(new Date(2024, 6, 15))?.season).toBe('summer');
  });

  it('returns the correct active season for a mid-season date', () => {
    expect(pricing.getActiveSeason(new Date(2024, 6, 15))?.season).toBe('summer');
    expect(pricing.getActiveSeason(new Date(2024, 3, 15))?.season).toBe('spring');
    expect(pricing.getActiveSeason(new Date(2024, 9, 15))?.season).toBe('fall');
  });

  it('handles season boundary start dates inclusively', () => {
    expect(pricing.getActiveSeason(new Date(2024, 5, 1))?.season).toBe('summer'); // Jun 1
    expect(pricing.getActiveSeason(new Date(2024, 2, 1))?.season).toBe('spring'); // Mar 1
    expect(pricing.getActiveSeason(new Date(2024, 8, 1))?.season).toBe('fall'); // Sep 1
  });

  it('handles season boundary end dates inclusively', () => {
    expect(pricing.getActiveSeason(new Date(2024, 7, 31))?.season).toBe('summer'); // Aug 31
    expect(pricing.getActiveSeason(new Date(2024, 4, 31))?.season).toBe('spring'); // May 31
    expect(pricing.getActiveSeason(new Date(2024, 10, 30))?.season).toBe('fall'); // Nov 30
  });

  it('handles a season that wraps around the year end', () => {
    expect(pricing.getActiveSeason(new Date(2024, 11, 15))?.season).toBe('winter'); // Dec 15
    expect(pricing.getActiveSeason(new Date(2024, 0, 15))?.season).toBe('winter'); // Jan 15
    expect(pricing.getActiveSeason(new Date(2024, 1, 28))?.season).toBe('winter'); // Feb 28
  });

  it('applies the seasonal multiplier in calculatePrice', () => {
    const summerPrice = pricing.calculatePrice(100, new Date(2024, 6, 15));
    expect(summerPrice).toBeCloseTo(100 * 0.12 * 1.3, 5);

    const winterPrice = pricing.calculatePrice(100, new Date(2024, 11, 15));
    expect(winterPrice).toBeCloseTo(100 * 0.12 * 1.5, 5);

    const springPrice = pricing.calculatePrice(100, new Date(2024, 3, 15));
    expect(springPrice).toBeCloseTo(100 * 0.12 * 1.0, 5);
  });

  it('falls back to a multiplier of 1 when no season matches', () => {
    const empty = new SeasonalPricing();
    empty.setSeasonalRates([]);
    expect(empty.getActiveSeason(new Date(2024, 6, 15))).toBeNull();
    expect(empty.calculatePrice(100, new Date(2024, 6, 15))).toBeCloseTo(100 * 0.12, 5);
  });
});