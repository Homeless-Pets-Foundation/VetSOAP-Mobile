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
