export const PROCESSING_STEP_LABELS = {
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  generating: 'Generating SOAP',
  completed: 'Complete',
} as const;

export const PROCESSING_WARMTH = [
  'Checking the visit audio.',
  'Turning key findings into a clean note.',
  'Organizing details for review.',
  'Almost ready for your final pass.',
] as const;

export const UPLOAD_OVERLAY_COPY = {
  title: 'Uploading Recording',
  titleMulti: 'Uploading Recordings',
  reassurance: 'Keep the app open while we upload.',
  /** Phase label shown while FFmpeg is splitting an oversized recording before any bytes are uploaded. */
  phasePreparing: 'Preparing audio…',
  // Single ellipsis character (…) everywhere — mixed "..." vs "…" reads as a
  // typo, and three dots widen the label enough to clip in narrow cards.
  phaseStarting: 'Preparing…',
  phaseUploading: 'Uploading…',
  phaseProcessing: 'Processing…',
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
  edit: 'Edit',
  copy: 'Copy',
  copyAll: 'Copy All',
  copied: 'Copied!',
} as const;

export const SPECIES_OTHER_COPY = {
  segmentLabel: 'Other',
  inputLabel: 'Species (type it in)',
  placeholder: 'e.g., Avian, Rabbit, Equine',
} as const;

export const AUDIO_PLAYER_COPY = {
  title: 'Audio',
  unavailable: 'Audio unavailable. Check your connection and try again.',
  forbidden: 'Only the recording author or an admin can play this audio.',
  retry: 'Retry',
  disabledWhileRecording:
    'Playback is paused while a recording is in progress. Finish the recording to listen.',
  part: (n: number): string => `Part ${n}`,
} as const;

export const RECORD_BANNERS = {
  pendingDraftOffline: 'Draft recording pending upload — connect to Wi-Fi to sync',
  pendingDraftOnline: 'Draft saved locally — syncing to server…',
} as const;

export const TRANSCRIPT_COPY = {
  toggleSoap: 'SOAP Note',
  toggleTranscript: 'Transcript',
  copy: 'Copy',
  copied: 'Copied!',
} as const;

export const CLIENT_EMAIL_COPY = {
  title: 'Client Email',
  body: 'Generate a visit summary for the client.',
  generate: 'Generate Email',
  regenerate: 'Regenerate',
  copy: 'Copy',
  openMail: 'Open in Mail',
  share: 'Share',
  copied: 'Draft copied.',
  failed: 'Could not generate email draft.',
  copyFailed: 'Copy failed.',
  shareFailed: 'Share failed.',
  fallbackCopied: 'Draft copied. Open your mail app and paste it.',
  bodyCopied: 'Email body copied — paste it into your message.',
} as const;

export const EXPORT_COPY = {
  title: 'Export',
  copyAll: 'Copy All',
  shareText: 'Share Text',
  sharePdf: 'Share PDF',
  markPims: 'Mark exported to PIMS',
  chromeExtensionHint:
    'The Captivet Chrome extension sends SOAP notes straight into your PIMS from your browser.',
  copied: 'Copied SOAP note.',
  shared: 'Shared SOAP note.',
  marked: 'Marked exported.',
  copyFailed: 'Copy failed.',
  shareFailed: 'Share failed.',
  pdfFailed: 'PDF export failed.',
  markFailed: 'Export failed.',
} as const;

export const TRANSLATION_COPY = {
  title: 'Translate',
  body: 'Translate SOAP sections for client communication.',
  languagePicker: 'Language',
  translate: 'Translate',
  copy: 'Copy',
  copied: 'Copied translation.',
  failed: 'Translation failed.',
  copyFailed: 'Copy failed.',
} as const;

export const SUGGESTED_TASKS_COPY = {
  title: 'Suggested Tasks',
  subtitle: 'AI-inferred charges and follow-ups from this visit.',
  chargesHeading: 'Clinical Record Charges',
  followUpHeading: 'Follow Up',
  accept: 'Accept',
  dismiss: 'Dismiss',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  done: 'Done',
  acceptFailed: 'Could not accept this task. Please try again.',
  dismissFailed: 'Could not dismiss this task. Please try again.',
} as const;

export const TEMPLATE_DEFAULT_COPY = {
  makeDefault: 'Set default',
  defaultLabel: 'Default template',
  saveFailed: {
    title: 'Default Not Saved',
    body: 'Could not save your default template. Please try again.',
  },
} as const;

export const PROFILE_COPY = {
  passwordUpdateFailed: 'Could not update your password. Please try again.',
  passwordUpdateTimeout: 'Password update timed out. Check your connection and try again.',
  passwordWeak: 'Choose a stronger password and try again.',
  nameRequired: 'Name is required.',
  nameTooLong: 'Name must be 120 characters or fewer.',
  profileUpdatedTitle: 'Profile Updated',
  profileUpdatedBody: 'Your name has been saved.',
  saveFailedTitle: 'Save Failed',
  saveFailedBody: 'Could not update your profile. Please try again.',
  passwordMinLength: 'Use at least 8 characters.',
  passwordsMismatch: 'Passwords do not match.',
  passwordUpdatedTitle: 'Password Updated',
  passwordUpdatedBody: 'Use your new password the next time you sign in.',
  passwordUpdateFailedTitle: 'Password Update Failed',
  goBack: 'Go back',
  title: 'Profile',
  accountName: 'Account Name',
  fullName: 'Full name',
  saveProfile: 'Save Profile',
  password: 'Password',
  passwordSubtitle: 'Change your sign-in password',
  newPassword: 'New password',
  confirmPassword: 'Confirm password',
  updatePassword: 'Update Password',
} as const;

export const SUBSCRIPTION_COPY = {
  statusTrial: 'Trial',
  statusActive: 'Active',
  statusPastDue: 'Past Due',
  statusCanceled: 'Canceled',
  openFailedTitle: 'Could Not Open Billing',
  openFailedBody: 'Please try again in a moment.',
  goBack: 'Go back',
  title: 'Subscription',
  loadFailed: 'Could not load subscription details.',
  retry: 'Retry',
  currentPlan: 'Current Plan',
  defaultPlan: 'Captivet',
  trialEnds: 'Trial ends',
  accessEnds: 'Access ends',
  renews: 'Renews',
  seats: (used: number, total: number): string => `${used} of ${total} seats`,
  seatsLabel: 'Seats',
  noBillingDates: 'No billing dates available.',
  manageBilling: 'Manage Billing',
  billingPortalOwnersOnly: 'Billing portal is available to organization owners and administrators.',
} as const;

export const DELETE_ACCOUNT_COPY = {
  signOutFailedTitle: 'Sign Out Failed',
  signOutFailedBody:
    'The deletion request was received, but sign-out failed. Please try signing out again.',
  deletionRequestedTitle: 'Deletion Requested',
  deletionScheduled: (purgeDate: string): string =>
    `Your account is scheduled for deletion on ${purgeDate}. You will be signed out now.`,
  deletionReceived: 'Your account deletion request was received. You will be signed out now.',
  signOut: 'Sign Out',
  requestFailedTitle: 'Request Failed',
  requestFailedBody: 'Could not request account deletion. Please try again.',
  ownerTransferRequiredTitle: 'Owner Transfer Required',
  ownerTransferRequired: "You're the only owner. Transfer organization ownership before deleting your account.",
  typeDeleteRequired: 'Type DELETE to confirm.',
  unsentTitle: 'Unsent Recordings',
  unsentBody: (unsentCount: number): string =>
    `You have ${unsentCount} recording${unsentCount === 1 ? '' : 's'} on this device not yet sent for SOAP notes. They will stay on this device after sign-out. Continue with account deletion?`,
  cancel: 'Cancel',
  continue: 'Continue',
  goBack: 'Go back',
  title: 'Delete Account',
  permanentDeletion: 'Permanent deletion',
  permanentDeletionBody: 'Captivet will schedule your account for deletion and sign you out.',
  localUnsentBody:
    'Local unsent recordings are not wiped by sign-out. Review and submit anything important before continuing.',
  typeDelete: 'Type DELETE',
  requestDeletion: 'Request Deletion',
} as const;

export const REVIEW_STATUS_COPY = {
  reviewed: 'Reviewed',
  needsReview: 'Needs review',
  markedReviewed: 'Marked reviewed',
  markReview: 'Mark reviewed',
} as const;

export const UNTITLED_VISIT_LABEL = 'Untitled visit';

export const RECORD_FIRST_FORM_HINT =
  'Patient details are optional. Captivet can fill blank fields from the recording after upload.';

export const METADATA_REVIEW_COPY = {
  title: 'AI filled these details',
  body: 'Review the details Captivet found in the recording.',
  looksRight: 'Looks Right',
  editDetails: 'Edit Details',
  addTitle: 'Add patient details',
  addBody: 'This visit has no patient details yet.',
  addBodyNoExtraction:
    "Captivet couldn't read the patient details from this recording. Add them here.",
  addDetails: 'Add Details',
  suggestionsTitle: 'Captivet found these — tap to add',
  editTitle: 'Patient details',
  editBody: 'Edit patient details or add a PIMS Patient ID.',
  sheetTitle: 'Patient Details',
  save: 'Save Details',
  cancel: 'Cancel',
  failed: 'Could not save details. Please try again.',
  aiLabeled: 'AI-labeled',
} as const;

export const REGENERATE_SOAP_COPY = {
  title: 'Regenerate SOAP note?',
  body: 'This will replace the current SOAP note after processing finishes.',
  confirm: 'Regenerate',
  button: 'Regenerate SOAP',
} as const;

export const REPROCESS_MODELS_COPY = {
  entryButton: 'Reprocess with different models',
  sheetTitle: 'Reprocess Recording',
  sheetBody:
    'Choose the transcription and SOAP models, then reprocess. This replaces the current ' +
    'transcript and SOAP note and runs new processing.',
  transcriptionLabel: 'Transcription model',
  soapLabel: 'SOAP note model',
  currentPrefix: 'Last used: ',
  confirm: 'Reprocess ', // trailing space: prevents Android single-word clipping in flex-row (CLAUDE.md UI gotcha)
  cancel: 'Cancel',
  failure: 'Could not start reprocessing. Please try again.',
  invalidModel: 'That model is not available for your organization.',
} as const;

export const OFFLINE_BANNER_COPY = {
  body: 'Showing saved account info — reconnecting…',
} as const;

export const ACCOUNT_LOAD_ERROR_COPY = {
  title: "Can't reach Captivet",
  body:
    "We can't reach Captivet right now. Your recordings are safe on this device — " +
    'check your connection and try again.',
  retry: 'Retry',
  detailsPrefix: 'Details: ',
  signOut: 'Sign out',
} as const;

export const DEVICE_REGISTRATION_BANNER_COPY = {
  title: 'Device setup incomplete',
  body: 'Some features may not work until your device is registered.',
  retry: 'Retry',
  retrying: 'Retrying…',
} as const;

export const THEME_COPY = {
  title: 'Appearance',
  subtitle: 'Choose light, dark, or your device setting',
  system: 'System',
  light: 'Light',
  dark: 'Dark',
} as const;

export const LONG_RECORDING_WARNING_COPY = {
  body: 'Long recording — may be slow to edit on older tablets.',
} as const;

// Non-blocking warning appears when cumulative slot duration crosses this threshold.
// The waveform editor still works, but peak extraction on weak hardware (e.g. A7 Lite)
// can take a long time for multi-hour recordings.
export const LONG_RECORDING_WARNING_THRESHOLD_SEC = 2 * 60 * 60;
