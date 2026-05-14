export const PROCESSING_STEP_LABELS = {
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  generating: 'Generating SOAP',
  completed: 'Complete',
} as const;

export const UPLOAD_OVERLAY_COPY = {
  title: 'Uploading Recording',
  titleMulti: 'Uploading Recordings',
  reassurance: 'Please wait while your recording uploads.',
  /** Phase label shown while FFmpeg is splitting an oversized recording before any bytes are uploaded. */
  phasePreparing: 'Preparing audio…',
} as const;

export const SILENT_CHECK_COPY = {
  title: 'Recording sounds silent',
  body:
    'Your microphone signal looked very quiet. If you can hear the audio on playback in Edit Recording, ' +
    'tap Upload Anyway. Otherwise cancel and re-record.',
  cancel: 'Cancel',
  upload: 'Upload Anyway',
} as const;

export const OVERSIZED_CONFIRM_COPY = {
  title: 'Recording is large',
  /** Body builder. `hours` rounded to 1 decimal, `mb` rounded to whole MB, `parts` is the predicted part count. */
  body: (hours: number, mb: number, parts: number): string =>
    `Your ${hours.toFixed(1)}-hour recording (${mb} MB) will be uploaded in ${parts} parts. ` +
    `This may take a few minutes. Continue?`,
  cancel: 'Cancel',
  upload: 'Upload',
} as const;

export const SOAP_SECTION_ACTIONS = {
  copy: 'Copy',
  copyAll: 'Copy All',
  copied: 'Copied!',
} as const;

export const DEVICE_REGISTRATION_BANNER_COPY = {
  title: 'Device setup incomplete',
  body: 'Some features may not work until your device is registered.',
  retry: 'Retry',
  retrying: 'Retrying…',
} as const;

export const LONG_RECORDING_WARNING_COPY = {
  body: 'Long recording — may be slow to edit on older tablets.',
} as const;

// Non-blocking warning appears when cumulative slot duration crosses this threshold.
// The waveform editor still works, but peak extraction on weak hardware (e.g. A7 Lite)
// can take a long time for multi-hour recordings.
export const LONG_RECORDING_WARNING_THRESHOLD_SEC = 2 * 60 * 60;
