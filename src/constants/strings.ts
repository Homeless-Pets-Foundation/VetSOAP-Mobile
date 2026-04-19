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
