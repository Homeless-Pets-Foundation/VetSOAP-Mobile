import { z } from 'zod';

// Sanitize a string: trim whitespace, strip control characters
function sanitize(val: string): string {
  return val.trim().replace(/[\x00-\x1F\x7F]/g, '');
}

// UUID v4 pattern for recording IDs
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPOINTMENT_TYPES = ['Wellness Exam', 'Sick Visit', 'Urgent/Emergency', 'Follow-up'] as const;

function optionalSanitizedString(max: number, message: string) {
  return z.preprocess((value) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') return value;
    const sanitized = sanitize(value);
    return sanitized.length > 0 ? sanitized : undefined;
  }, z.string().max(max, message).optional());
}

const optionalAppointmentTypeSchema = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  const sanitized = sanitize(value);
  return sanitized.length > 0 ? sanitized : undefined;
}, z.enum(APPOINTMENT_TYPES).optional());

export const recordingIdSchema = z
  .string()
  .regex(uuidPattern, 'Invalid recording ID format');

export const createRecordingSchema = z.object({
  pimsPatientId: optionalSanitizedString(100, 'PIMS ID too long'),
  patientName: z.preprocess(
    (value) => (typeof value === 'string' ? sanitize(value) : value),
    z.string().max(100, 'Patient name too long')
  ),
  clientName: optionalSanitizedString(100, 'Client name too long'),
  species: optionalSanitizedString(50, 'Species name too long'),
  breed: optionalSanitizedString(100, 'Breed name too long'),
  appointmentType: optionalAppointmentTypeSchema,
  foreignLanguage: z.boolean().optional(),
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
  .min(8, 'Password must be at least 8 characters')
  .max(256, 'Password must be at most 256 characters');

export type CreateRecordingInput = z.input<typeof createRecordingSchema>;
export type ValidatedCreateRecording = z.output<typeof createRecordingSchema>;
