/**
 * Demand Response API Routes
 */

import express, { Request, Response, NextFunction } from 'express';
import {
  getPeakEvent,
  getParticipationHistory,
  getProgramStats,
  detectPeakDemand,
  processParticipation,
  notifyUsers,
  updateEventStatus
} from '../lib/demandResponse.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../middleware/adminAuth.js';

const router = express.Router();

/**
 * GET /api/demand-response/stats
 * Get program statistics and ROI metrics
 */
router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = getProgramStats();
    
    res.json({
      success: true,
      stats: {
        totalEvents: stats.totalEvents,
        activeParticipants: stats.activeParticipants,
        totalReductionKwh: stats.totalReduction,
        totalRewardsDistributed: stats.totalRewardsDistributed,
        averageParticipationRate: stats.averageParticipationRate.toFixed(2) + '%',
        roi: stats.roi.toFixed(2) + '%',
        programHealth: stats.roi > 0 ? 'positive' : 'negative'
      }
    });
  } catch (error: any) {
    logger.error('Error fetching program stats', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/demand-response/events
 * Get all peak events
 */
router.get('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, limit = 50 } = req.query;
    
    const db = (req as any).db;
    let query = 'SELECT * FROM peak_events';
    const params: any[] = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY start_time DESC LIMIT ?';
    params.push(Number(limit));
    
    const events = db.prepare(query).all(...params).map((row: any) => ({
      id: row.id,
      startTime: new Date(row.start_time).toISOString(),
      endTime: new Date(row.end_time).toISOString(),
      predictedDemand: row.predicted_demand,
      threshold: row.threshold,
      status: row.status,
      notificationsSent: row.notifications_sent === 1,
      createdAt: new Date(row.created_at).toISOString()
    }));
    
    res.json({
      success: true,
      events,
      count: events.length
    });
  } catch (error: any) {
    logger.error('Error fetching events', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/demand-response/events/:eventId
 * Get specific peak event details
 */
router.get('/events/:eventId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventId } = req.params;
    const event = getPeakEvent(eventId);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        error: 'Peak event not found'
      });
    }
    
    // Get participant count
    const db = (req as any).db;
    const participantStats = db.prepare(`
      SELECT 
        COUNT(*) as participant_count,
        SUM(reduction) as total_reduction,
        SUM(reward_amount) as total_rewards
      FROM demand_response_participants
      WHERE peak_event_id = ?
    `).get(eventId);
    
    res.json({
      success: true,
      event: {
        ...event,
        startTime: event.startTime.toISOString(),
        endTime: event.endTime.toISOString(),
        createdAt: event.createdAt.toISOString()
      },
      participants: {
        count: participantStats.participant_count || 0,
        totalReduction: participantStats.total_reduction || 0,
        totalRewards: participantStats.total_rewards || 0
      }
    });
  } catch (error: any) {
    logger.error('Error fetching event', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/demand-response/participation/:meterId
 * Get participation history for a meter
 */
router.get('/participation/:meterId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meterId } = req.params;
    const history = getParticipationHistory(meterId);
    
    const formatted = history.map(p => ({
      peakEventId: p.peakEventId,
      baselineConsumption: p.baselineConsumption,
      actualConsumption: p.actualConsumption,
      reduction: p.reduction,
      rewardAmount: p.rewardAmount,
      participatedAt: p.participatedAt.toISOString()
    }));
    
    // Calculate totals
    const totals = history.reduce((acc, p) => ({
      totalReduction: acc.totalReduction + p.reduction,
      totalRewards: acc.totalRewards + p.rewardAmount,
      eventCount: acc.eventCount + 1
    }), { totalReduction: 0, totalRewards: 0, eventCount: 0 });
    
    res.json({
      success: true,
      meterId,
      history: formatted,
      summary: {
        participationCount: totals.eventCount,
        totalReductionKwh: totals.totalReduction,
        totalRewardsEarned: totals.totalRewards,
        averageRewardPerEvent: totals.eventCount > 0 
          ? (totals.totalRewards / totals.eventCount).toFixed(2) 
          : '0.00'
      }
    });
  } catch (error: any) {
    logger.error('Error fetching participation history', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/demand-response/detect
 * Manually trigger peak detection (admin only)
 */
router.post('/detect', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const peakEvent = detectPeakDemand();
    
    if (!peakEvent) {
      return res.json({
        success: true,
        message: 'No peak demand detected',
        peakDetected: false
      });
    }
    
    // Send notifications
    const notificationCount = await notifyUsers(peakEvent.id);
    
    res.json({
      success: true,
      message: 'Peak demand detected and notifications sent',
      peakDetected: true,
      event: {
        id: peakEvent.id,
        startTime: peakEvent.startTime.toISOString(),
        endTime: peakEvent.endTime.toISOString(),
        predictedDemand: peakEvent.predictedDemand,
        threshold: peakEvent.threshold
      },
      notificationsSent: notificationCount
    });
  } catch (error: any) {
    logger.error('Error in manual peak detection', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/demand-response/events/:eventId/process
 * Manually process participation for an event (admin only)
 */
router.post('/events/:eventId/process', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventId } = req.params;
    
    // Update status to completed if not already
    const event = getPeakEvent(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }
    
    if (event.status !== 'completed') {
      updateEventStatus(eventId, 'completed');
    }
    
    const participants = processParticipation(eventId);
    
    const totalReduction = participants.reduce((sum, p) => sum + p.reduction, 0);
    const totalRewards = participants.reduce((sum, p) => sum + p.rewardAmount, 0);
    
    res.json({
      success: true,
      message: 'Participation processed',
      results: {
        participantCount: participants.length,
        totalReductionKwh: totalReduction,
        totalRewardsDistributed: totalRewards
      }
    });
  } catch (error: any) {
    logger.error('Error processing participation', { error: error.message });
    next(error);
  }
});

/**
 * PUT /api/demand-response/events/:eventId/status
 * Update event status (admin only)
 */
router.put('/events/:eventId/status', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventId } = req.params;
    const { status } = req.body;
    
    const validStatuses = ['scheduled', 'active', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status',
        validStatuses
      });
    }
    
    updateEventStatus(eventId, status);
    
    res.json({
      success: true,
      message: 'Event status updated',
      eventId,
      newStatus: status
    });
  } catch (error: any) {
    logger.error('Error updating event status', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/demand-response/leaderboard
 * Get top participants by rewards earned
 */
router.get('/leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = 10 } = req.query;
    
    const db = (req as any).db;
    const leaderboard = db.prepare(`
      SELECT 
        drp.meter_id,
        mm.owner,
        COUNT(*) as participation_count,
        SUM(drp.reduction) as total_reduction,
        SUM(drp.reward_amount) as total_rewards
      FROM demand_response_participants drp
      JOIN meter_metadata mm ON mm.meter_id = drp.meter_id
      GROUP BY drp.meter_id
      ORDER BY total_rewards DESC
      LIMIT ?
    `).all(Number(limit));
    
    res.json({
      success: true,
      leaderboard: leaderboard.map((entry: any, index: number) => ({
        rank: index + 1,
        meterId: entry.meter_id,
        owner: entry.owner,
        participationCount: entry.participation_count,
        totalReductionKwh: entry.total_reduction,
        totalRewards: entry.total_rewards
      }))
    });
  } catch (error: any) {
    logger.error('Error fetching leaderboard', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/demand-response/analytics
 * Get detailed analytics for the program
 */
router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period = '30d' } = req.query;
    
    const db = (req as any).db;
    
    // Calculate time range
    const now = Date.now();
    const periodMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 :
                     period === '30d' ? 30 * 24 * 60 * 60 * 1000 :
                     period === '90d' ? 90 * 24 * 60 * 60 * 1000 :
                     30 * 24 * 60 * 60 * 1000;
    const startTime = now - periodMs;
    
    // Events by status
    const eventsByStatus = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM peak_events
      WHERE created_at >= ?
      GROUP BY status
    `).all(startTime);
    
    // Participation trend
    const participationTrend = db.prepare(`
      SELECT 
        DATE(participated_at/1000, 'unixepoch') as date,
        COUNT(*) as participants,
        SUM(reduction) as reduction,
        SUM(reward_amount) as rewards
      FROM demand_response_participants
      WHERE participated_at >= ?
      GROUP BY date
      ORDER BY date DESC
    `).all(startTime);
    
    // Hourly distribution
    const hourlyDistribution = db.prepare(`
      SELECT 
        strftime('%H', datetime(pe.start_time/1000, 'unixepoch')) as hour,
        COUNT(*) as event_count,
        AVG(pe.predicted_demand) as avg_demand
      FROM peak_events pe
      WHERE pe.created_at >= ?
      GROUP BY hour
      ORDER BY hour
    `).all(startTime);
    
    res.json({
      success: true,
      period,
      analytics: {
        eventsByStatus,
        participationTrend,
        hourlyDistribution
      }
    });
  } catch (error: any) {
    logger.error('Error fetching analytics', { error: error.message });
    next(error);
  }
});

export default router;
