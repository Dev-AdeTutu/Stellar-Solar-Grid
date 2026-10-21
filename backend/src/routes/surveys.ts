import { Router, Request, Response } from 'express';
import { registerDatabase } from '../db';

const router = Router();

// Initialize SQLite tables for surveys and survey responses
const db = registerDatabase('surveys', `
  CREATE TABLE IF NOT EXISTS surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'nps',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    respondent TEXT,
    score INTEGER NOT NULL,
    comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (survey_id) REFERENCES surveys(id)
  );
`);

// Admin-only middleware
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// POST /api/surveys - create a survey (admin-only)
router.post('/', requireAdmin, (req: Request, res: Response) => {
  const { title, question, type } = req.body || {};

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' });
  }

  const surveyType = typeof type === 'string' && type.length > 0 ? type : 'nps';

  try {
    const stmt = db.prepare(
      'INSERT INTO surveys (title, question, type, active) VALUES (?, ?, ?, 1)'
    );
    const info = stmt.run(title, question, surveyType);
    const survey = db
      .prepare('SELECT * FROM surveys WHERE id = ?')
      .get(info.lastInsertRowid);

    return res.status(201).json({ survey });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create survey' });
  }
});

// POST /api/surveys/:id/responses - record a response
router.post('/:id/responses', (req: Request, res: Response) => {
  const surveyId = Number(req.params.id);
  if (!Number.isInteger(surveyId) || surveyId <= 0) {
    return res.status(400).json({ error: 'Invalid survey id' });
  }

  const { respondent, score, comment } = req.body || {};

  const numericScore = Number(score);
  if (!Number.isInteger(numericScore) || numericScore < 0 || numericScore > 10) {
    return res.status(400).json({ error: 'score must be an integer between 0 and 10' });
  }

  if (comment !== undefined && comment !== null && typeof comment !== 'string') {
    return res.status(400).json({ error: 'comment must be a string' });
  }

  try {
    const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(surveyId);
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    const stmt = db.prepare(
      'INSERT INTO survey_responses (survey_id, respondent, score, comment) VALUES (?, ?, ?, ?)'
    );
    const info = stmt.run(
      surveyId,
      typeof respondent === 'string' ? respondent : null,
      numericScore,
      typeof comment === 'string' ? comment : null
    );

    const response = db
      .prepare('SELECT * FROM survey_responses WHERE id = ?')
      .get(info.lastInsertRowid);

    return res.status(201).json({ response });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to record response' });
  }
});

// GET /api/surveys/analytics - compute NPS and satisfaction metrics
router.get('/analytics', (_req: Request, res: Response) => {
  try {
    const surveys = db.prepare('SELECT * FROM surveys ORDER BY id ASC').all() as any[];
    const responses = db
      .prepare('SELECT * FROM survey_responses ORDER BY id ASC')
      .all() as any[];

    const totalResponses = responses.length;

    let promoters = 0;
    let passives = 0;
    let detractors = 0;
    let scoreSum = 0;

    for (const r of responses) {
      const score = Number(r.score);
      scoreSum += score;
      if (score >= 9) {
        promoters += 1;
      } else if (score >= 7) {
        passives += 1;
      } else {
        detractors += 1;
      }
    }

    const promoterPct = totalResponses > 0 ? (promoters / totalResponses) * 100 : 0;
    const detractorPct = totalResponses > 0 ? (detractors / totalResponses) * 100 : 0;
    const nps = Math.round(promoterPct - detractorPct);
    const averageScore = totalResponses > 0 ? scoreSum / totalResponses : 0;

    const perSurvey = surveys.map((survey) => {
      const surveyResponses = responses.filter((r) => r.survey_id === survey.id);
      const count = surveyResponses.length;

      let sPromoters = 0;
      let sPassives = 0;
      let sDetractors = 0;
      let sScoreSum = 0;

      for (const r of surveyResponses) {
        const score = Number(r.score);
        sScoreSum += score;
        if (score >= 9) {
          sPromoters += 1;
        } else if (score >= 7) {
          sPassives += 1;
        } else {
          sDetractors += 1;
        }
      }

      const sPromoterPct = count > 0 ? (sPromoters / count) * 100 : 0;
      const sDetractorPct = count > 0 ? (sDetractors / count) * 100 : 0;

      return {
        survey_id: survey.id,
        title: survey.title,
        question: survey.question,
        type: survey.type,
        active: Boolean(survey.active),
        response_count: count,
        promoters: sPromoters,
        passives: sPassives,
        detractors: sDetractors,
        nps: Math.round(sPromoterPct - sDetractorPct),
        average_score: count > 0 ? sScoreSum / count : 0,
      };
    });

    return res.json({
      total_surveys: surveys.length,
      total_responses: totalResponses,
      nps,
      average_satisfaction: averageScore,
      promoters,
      passives,
      detractors,
      promoter_percentage: promoterPct,
      detractor_percentage: detractorPct,
      per_survey: perSurvey,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

export default router;