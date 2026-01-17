/**
 * Tests for CompletionSubscriber
 */

import { CompletionSubscriber, TaskCompletion, FeedbackEvent } from './completion-subscriber';
import { Predictor } from '../interfaces/predictor';
import { Task, TaskPrediction } from '../interfaces/types';

/**
 * Mock predictor for testing
 */
class MockPredictor implements Predictor {
  feedbackCalls: Array<{
    taskId: string;
    workerId: string;
    success: boolean;
    actualDurationMs: number;
    taskType?: string;
  }> = [];

  async predict(_task: Task): Promise<TaskPrediction | null> {
    return null;
  }

  async feedback(
    taskId: string,
    workerId: string,
    success: boolean,
    actualDurationMs: number,
    taskType?: string
  ): Promise<void> {
    this.feedbackCalls.push({ taskId, workerId, success, actualDurationMs, taskType });
  }
}

describe('CompletionSubscriber', () => {
  let subscriber: CompletionSubscriber;
  let mockPredictor: MockPredictor;

  const createCompletion = (overrides: Partial<TaskCompletion> = {}): TaskCompletion => ({
    taskId: 'task-1',
    taskType: 'default',
    workerId: 'worker-1',
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1000,
    success: true,
    ...overrides,
  });

  beforeEach(() => {
    subscriber = new CompletionSubscriber();
    mockPredictor = new MockPredictor();
    subscriber.setPredictor(mockPredictor);
    subscriber.start();
  });

  afterEach(() => {
    subscriber.stop();
  });

  describe('processCompletion', () => {
    it('should update predictor with actual duration', async () => {
      const completion = createCompletion({
        taskId: 'task-1',
        taskType: 'my-type',
        workerId: 'worker-1',
        durationMs: 1500,
      });

      await subscriber.processCompletion(completion);

      expect(mockPredictor.feedbackCalls).toHaveLength(1);
      expect(mockPredictor.feedbackCalls[0].taskId).toBe('task-1');
      expect(mockPredictor.feedbackCalls[0].actualDurationMs).toBe(1500);
      expect(mockPredictor.feedbackCalls[0].taskType).toBe('my-type');
    });

    it('should not process when not running', async () => {
      subscriber.stop();

      await subscriber.processCompletion(createCompletion());

      expect(mockPredictor.feedbackCalls).toHaveLength(0);
    });

    it('should track completion count', async () => {
      await subscriber.processCompletion(createCompletion());
      await subscriber.processCompletion(createCompletion());

      expect(subscriber.getCompletionCount()).toBe(2);
    });

    it('should detect drift when prediction provided', async () => {
      const events: FeedbackEvent[] = [];
      subscriber.on('feedback', (e) => events.push(e));

      // Large underprediction - actual 3x predicted
      const completion = createCompletion({
        durationMs: 3000,
        predictedDurationMs: 1000,
      });

      await subscriber.processCompletion(completion);

      const driftEvent = events.find((e) => e.type === 'drift_detected');
      expect(driftEvent).toBeDefined();
      if (driftEvent?.type === 'drift_detected') {
        expect(driftEvent.drift.isDrift).toBe(true);
      }
    });

    it('should not detect drift for accurate predictions', async () => {
      const events: FeedbackEvent[] = [];
      subscriber.on('feedback', (e) => events.push(e));

      const completion = createCompletion({
        durationMs: 1100,
        predictedDurationMs: 1000,
      });

      await subscriber.processCompletion(completion);

      const driftEvent = events.find((e) => e.type === 'drift_detected');
      expect(driftEvent).toBeUndefined();
    });

    it('should emit prediction_updated event', async () => {
      const events: FeedbackEvent[] = [];
      subscriber.on('feedback', (e) => events.push(e));

      await subscriber.processCompletion(createCompletion({
        durationMs: 1500,
        predictedDurationMs: 1000,
      }));

      const updateEvent = events.find((e) => e.type === 'prediction_updated');
      expect(updateEvent).toBeDefined();
      if (updateEvent?.type === 'prediction_updated') {
        expect(updateEvent.actual).toBe(1500);
        expect(updateEvent.predicted).toBe(1000);
      }
    });

    it('should track accuracy', async () => {
      await subscriber.processCompletion(createCompletion({
        durationMs: 1000,
        predictedDurationMs: 1000,
      }));
      await subscriber.processCompletion(createCompletion({
        durationMs: 5000,
        predictedDurationMs: 1000,
      }));

      const stats = subscriber.getAccuracyStats();
      expect(stats.total).toBe(2);
      expect(stats.accuracy).toBe(0.5);
    });
  });

  describe('getAccuracyStats', () => {
    it('should return stats from accuracy tracker', async () => {
      await subscriber.processCompletion(createCompletion({
        durationMs: 1000,
        predictedDurationMs: 1000,
        taskType: 'type-a',
      }));
      await subscriber.processCompletion(createCompletion({
        durationMs: 1100,
        predictedDurationMs: 1000,
        taskType: 'type-b',
      }));

      const stats = subscriber.getAccuracyStats();
      expect(stats.total).toBe(2);
      expect(stats.taskTypes).toBe(2);
    });
  });

  describe('getAccuracyByTaskType', () => {
    it('should return breakdown by task type', async () => {
      await subscriber.processCompletion(createCompletion({
        taskType: 'type-a',
        durationMs: 1000,
        predictedDurationMs: 1000,
      }));
      await subscriber.processCompletion(createCompletion({
        taskType: 'type-a',
        durationMs: 1100,
        predictedDurationMs: 1000,
      }));
      await subscriber.processCompletion(createCompletion({
        taskType: 'type-b',
        durationMs: 5000,
        predictedDurationMs: 1000,
      }));

      const byType = subscriber.getAccuracyByTaskType();
      const typeA = byType.find((t) => t.taskType === 'type-a');
      const typeB = byType.find((t) => t.taskType === 'type-b');

      expect(typeA?.accuracy).toBe(1);
      expect(typeB?.accuracy).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset completion count and accuracy', async () => {
      await subscriber.processCompletion(createCompletion({
        predictedDurationMs: 1000,
      }));
      await subscriber.processCompletion(createCompletion({
        predictedDurationMs: 1000,
      }));

      subscriber.reset();

      expect(subscriber.getCompletionCount()).toBe(0);
      expect(subscriber.getAccuracyStats().total).toBe(0);
    });
  });

  describe('isActive', () => {
    it('should return true when running', () => {
      expect(subscriber.isActive()).toBe(true);
    });

    it('should return false when stopped', () => {
      subscriber.stop();
      expect(subscriber.isActive()).toBe(false);
    });
  });

  describe('accuracy warning', () => {
    it('should emit warning when accuracy drops below 80%', async () => {
      const events: FeedbackEvent[] = [];
      subscriber.on('feedback', (e) => events.push(e));

      // Process 100 completions (all inaccurate) to trigger check
      for (let i = 0; i < 100; i++) {
        await subscriber.processCompletion(createCompletion({
          taskId: `task-${i}`,
          durationMs: 5000,
          predictedDurationMs: 1000,
        }));
      }

      const warningEvent = events.find((e) => e.type === 'accuracy_warning');
      expect(warningEvent).toBeDefined();
    });
  });
});
