import type { Recording, ReviewStatus } from '../types';

type ServerReviewFields = {
  review_status?: ReviewStatus | null;
};

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return value === 'needs_review' || value === 'reviewed';
}

export function getRecordingReviewStatus(recording: Recording): ReviewStatus | null {
  if (isReviewStatus(recording.reviewStatus)) return recording.reviewStatus;
  const snakeCaseStatus = (recording as Recording & ServerReviewFields).review_status;
  return isReviewStatus(snakeCaseStatus) ? snakeCaseStatus : null;
}
