import { Router, Request, Response } from 'express';

const router = Router();

interface CrowdfundRequestBody {
  title?: string;
  description?: string;
  goalAmount?: number;
  endDate?: string;
  [key: string]: unknown;
}

router.post('/', (req: Request, res: Response) => {
  const body = req.body as CrowdfundRequestBody;
  const { endDate } = body;

  if (endDate === undefined || endDate === null || endDate === '') {
    return res.status(400).json({
      error: 'endDate is required',
      code: 'VALIDATION_ERROR',
    });
  }

  const parsedEndDate = new Date(endDate as string);

  if (isNaN(parsedEndDate.getTime())) {
    return res.status(400).json({
      error: 'endDate must be a valid date',
      code: 'VALIDATION_ERROR',
    });
  }

  if (parsedEndDate.getTime() <= Date.now()) {
    return res.status(400).json({
      error: 'endDate must be in the future',
      code: 'VALIDATION_ERROR',
    });
  }

  // Validation passed; campaign creation logic would proceed here.
  return res.status(201).json({
    message: 'Crowdfund campaign created',
    campaign: {
      ...body,
      endDate: parsedEndDate.toISOString(),
    },
  });
});

export default router;