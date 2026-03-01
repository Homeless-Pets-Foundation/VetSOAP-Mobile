import { z } from 'zod';

// Sanitize a string: trim whitespace, strip control characters
function sanitize(val: string): string {
  // eslint-disable-next-line no-control-regex
  return val.trim().replace(/[\x00-\x1F\x7F]/g, '');
}

// UUID v4 pattern for recording IDs
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const recordingIdSchema = z
  .string()
  .regex(uuidPattern, 'Invalid recording ID format');

export const createRecordingSchema = z.object({
  patientName: z
    .string()
    .transform(sanitize)
    .pipe(z.string().min(1, 'Patient name is required').max(200, 'Patient name too long')),
  clientName: z
    .string()
    .transform(sanitize)
    .pipe(z.string().min(1, 'Client name is required').max(200, 'Client name too long')),
  species: z
    .string()
    .transform(sanitize)
    .pipe(z.string().min(1, 'Species is required').max(100, 'Species name too long')),
  breed: z
    .string()
    .optional()
    .transform((v) => (v ? sanitize(v) : v))
    .pipe(z.string().max(100, 'Breed name too long').optional()),
  appointmentType: z
    .string()
    .optional()
    .transform((v) => (v ? sanitize(v) : v))
    .pipe(z.string().max(100, 'Appointment type too long').optional()),
  templateId: z.string().uuid().optional(),
});

export const searchQuerySchema = z
  .string()
  .transform(sanitize)
  .pipe(z.string().max(200, 'Search query too long'));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Please enter a valid email address');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters');

export type CreateRecordingInput = z.input<typeof createRecordingSchema>;
export type ValidatedCreateRecording = z.output<typeof createRecordingSchema>;
