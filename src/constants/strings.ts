export const PROCESSING_STEP_LABELS = {
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  generating: 'Generating SOAP',
  completed: 'Complete',
  /** Shown on the active step while status is retry_scheduled. */
  retrying: 'Retrying…',
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
  hide: 'Hide',
  /** Compact banner shown while the overlay is hidden but uploads continue. */
  backgroundProgress: (done: number, total: number): string =>
    `Uploading ${Math.min(done + 1, total)} of ${total}… Tap to view`,
  announceSingle: 'Upload in progress',
  announceMulti: (total: number): string => `Uploading ${total} recordings`,
} as const;

export const STALE_RECORDING_UPLOAD_COPY =
  "We couldn't finish the upload. The recording is still saved on this device. Check your connection and try again.";

export const SILENT_CHECK_COPY = {
  title: 'Recording sounds silent',
  body:
    'Your microphone signal looked very quiet. If you can hear the audio on playback in Edit Recording, ' +
    'tap Upload Anyway. Otherwise cancel and re-record.',
  /** Durable captures can't open Edit Recording — don't reference it. */
  bodyDurable:
    "Your microphone signal looked very quiet. If you're sure the visit was captured, " +
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

export const LOGIN_COPY = {
  forgotPassword: 'Forgot password?',
  continueWithGoogle: 'Continue with Google',
  orContinueWith: 'or continue with',
  lockout: (seconds: number): string =>
    `Too many failed attempts. Please try again in ${seconds}s.`,
  networkError: 'A network error occurred. Please check your connection and try again.',
} as const;

export const PASSWORD_RESET_COPY = {
  sendFailed:
    "Couldn't send the reset email. Check the address and your connection, then try again.",
  sendRateLimited: 'Too many attempts — wait a minute and try again.',
  updateFailed:
    "Couldn't update the password. Your reset link may have expired — request a new one from the sign-in screen.",
  passwordTooShort: 'Password must be at least 8 characters.',
  passwordMismatch: 'Both password fields must match.',
  resend: 'Resend email',
  resendCooldown: (seconds: number): string => `Resend email (${seconds}s)`,
  tapLink:
    "Tap the link in the email to reset your password. If you don't see the email, check your spam folder.",
} as const;

export const DEVICE_LIMIT_COPY = {
  signOut: 'Sign out instead',
  stillAtLimit: 'Still at the device limit. Revoke a device below or sign out.',
  revokeFailed: "Couldn't revoke that device. Check your connection and try again.",
} as const;

export const MFA_BOOTSTRAP_COPY = {
  failed: "Couldn't load verification. Check your connection and try again.",
  retry: 'Try Again',
} as const;

export const DISCARD_SESSION_COPY = {
  title: 'Discard Recordings?',
  /** Body when every at-risk slot is truly unsaved (no drafts involved). */
  body: (unsavedCount: number): string =>
    unsavedCount === 1
      ? 'You have 1 unsubmitted recording. Leaving will discard it.'
      : `You have ${unsavedCount} unsubmitted recordings. Leaving will discard them.`,
  /** Body when the session also holds finished drafts — those are durable and survive. */
  bodyWithDrafts: (unsavedCount: number): string =>
    unsavedCount === 1
      ? 'You have 1 recording that is not saved yet. Leaving will discard it. Finished drafts stay in Not Submitted.'
      : `You have ${unsavedCount} recordings that are not saved yet. Leaving will discard them. Finished drafts stay in Not Submitted.`,
  stay: 'Stay',
  discard: 'Discard',
} as const;

export const REPLACE_SESSION_COPY = {
  title: 'Replace Current Session?',
  /** Load-draft variant: truly-unsaved work is replaced; drafts are preserved. */
  bodyLoadDraft:
    'You have unsaved recordings in progress. Loading this draft will replace them. Finished drafts stay in Not Submitted.',
  /** Resume-stash variant. */
  bodyResumeStash:
    'You have unsaved recordings in progress. Resuming this saved session will replace them. Finished drafts stay in Not Submitted.',
  cancel: 'Cancel',
  loadDraft: 'Load Draft',
  replace: 'Replace',
} as const;

/**
 * Saved-session ("stash") copy. User-facing vocabulary is consolidated on two
 * concepts (2026-07 audit theme C): "Saved sessions" (stash) and
 * "Not Submitted" (drafts) — don't introduce new synonyms.
 */
export const STASH_COPY = {
  saveForLater: 'Save for Later',
  savedFull: (max: number): string => `Saved Full (${max})`,
  atCapacityTitle: 'Saved Sessions Full',
  atCapacityBody: (max: number): string =>
    `You can keep up to ${max} saved sessions. Resume or delete one to save another.`,
  confirmStopTitle: 'Save for Later?',
  confirmStopBody:
    'Your active recording will be finished and saved. You can resume this session later to add more.',
  confirmStopSave: 'Save',
  cancel: 'Cancel',
  savedTitle: 'Session Saved',
  savedBody: 'Your recordings are under Saved Sessions on this screen. Resume them anytime.',
  saveFailedTitle: 'Save Failed',
  saveFailedBody:
    'Could not save your session. Your recordings are still here — please try again or submit them now.',
  autoSavedTitle: 'Saved for Later',
  autoSavedBody:
    "Your network was unstable, so we saved this for you. Open it from Saved Sessions and tap Resume once you're back online.",
  deleteTitle: 'Delete Saved Session?',
  deleteBody: 'Audio recordings will be permanently deleted. This cannot be undone.',
  delete: 'Delete',
  sectionTitle: (count: number): string => `Saved Sessions (${count})`,
  audioMissingTitle: 'Audio Files Missing',
  audioMissingBody: 'All audio files for this saved session have been deleted. It will be removed.',
  someAudioMissingTitle: 'Some Audio Missing',
  someAudioMissingBody: (missingCount: number): string =>
    `${missingCount} audio segment(s) could not be found. Resume with available data?`,
  resumeAnyway: 'Resume Anyway',
  resumeFailedTitle: 'Resume Failed',
  resumeFailedBody: 'Could not restore your session.',
} as const;

export const ERROR_COPY = {
  network: 'No internet connection. Please check your network and try again.',
  server: 'Something went wrong on our end. Please try again in a moment.',
  timeout: 'The request timed out. Check your connection and try again.',
  rateLimited: 'Too many requests — wait a moment and try again.',
  permission: "You don't have permission to do that.",
  loadFailed: "Couldn't load this right now. Check your connection and try again.",
  uploadGeneric: 'Upload failed. Please try again.',
  processingFailedBody:
    'Something went wrong while generating this note. Retry processing, or copy the details for support.',
  copyDetails: 'Copy details for support',
  detailsCopied: 'Details copied',
} as const;

export const RECOVERY_COPY = {
  subtitle: 'Recordings saved when a staff member signed out of this device.',
  emptyBody:
    'Nothing to recover here. Recordings are saved to this screen when a staff member signs out ' +
    'with unsent work; restore them to your drafts to review and submit.',
  timedOutBody:
    'This device did not finish checking local recovery storage. Try again while staying signed in.',
} as const;

export const RECORDING_DETAIL_COPY = {
  processingTitle: 'Processing…',
  processingBody: 'This usually takes 1-2 minutes.',
  processingFailedTitle: 'Processing Failed',
  awaitingMetadataTitle: 'Awaiting Patient Details',
  awaitingMetadataBody:
    'This recording was imported and needs patient details before processing can begin. Complete the details on the web app.',
  audioNotOnDeviceTitle: 'Audio Not on This Device',
  audioNotOnDeviceBody:
    'This draft was started on another device, or its local audio was cleared from this one. ' +
    'Submit it from the device where you recorded it, or delete it here to clean up.',
} as const;

export const SUBMITTED_BANNER_COPY = {
  title: (count: number): string =>
    count === 1 ? 'Recording submitted' : `${count} recordings submitted`,
  loadingRow: 'Loading…',
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
  speed: (rate: number): string => `${rate}x`,
} as const;

export const RECORDER_TRANSITION_COPY = {
  /** Toast + screen-reader announcement when swiping away auto-pauses a live recording. */
  autoPaused: (patientLabel: string): string => `Recording for ${patientLabel} paused`,
  /** Legacy interruption banner: partial segment saved, auto-resume armed. */
  interruptedPaused:
    'Recording paused by an interruption (call or another app) — auto-resuming when it ends.',
  /** Durable interruption banner: capture finalized as a submittable draft (no auto-resume in v1). */
  interruptedSaved:
    'An interruption ended this recording. The audio was saved — tap Continue Recording to add more.',
  dismiss: 'OK',
} as const;

export const RECORD_BANNERS = {
  pendingDraftOffline: 'Draft recording pending upload — connect to the internet to sync',
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
  statusUnknown: 'Unknown',
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
  seats: (count: number): string => `${count} billable ${count === 1 ? 'seat' : 'seats'}`,
  seatsLabel: 'Seats',
  monthlyTotal: 'Monthly total',
  annualTotal: 'Annual total',
  noBillingDates: 'No billing dates available.',
  manageBilling: 'Manage Billing',
  billingPortalOwnersOnly: 'Billing portal is available to organization owners and administrators.',
  adminOnly: 'Subscription details are available to organization owners and administrators.',
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

export const MULTI_PATIENT_RECORD_FIRST_COPY = {
  title: 'Add patient details first',
  body:
    'All multi-patient visits can include more than one patient name in each recording. ' +
    'Add each patient\'s details first instead of using Recording First so Captivet labels each SOAP note correctly.',
  addDetailsFirst: 'Add Details First',
  continueRecordingFirst: 'Continue Recording First',
  detailsSubtitle: 'Recommended before recording.',
  formHint:
    'For multi-patient visits, add each patient\'s details before recording. Patient names can appear across recordings and confuse AI labels.',
} as const;

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
  conflictCurrent: 'Current',
  conflictSuggested: 'AI suggests',
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
    'transcript and SOAP note and may use billable AI credits or provider usage.',
  confirmTitle: 'Reprocess recording?',
  confirmBody:
    'This will replace the current transcript and SOAP note and may use billable AI credits or provider usage.',
  transcriptionLabel: 'Transcription model',
  soapLabel: 'SOAP note model',
  currentPrefix: 'Last used: ',
  confirm: 'Reprocess', // clipping mitigation now lives inside ui/Button — plain label here
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
  retryFailed: 'Retry failed — check your connection and try again.',
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

export const CONSULT_COPY = {
  title: 'Consult AI',
  body: 'Open the Consult AI assistant in the Captivet web app.',
  open: 'Open',
} as const;

// Non-blocking warning appears when cumulative slot duration crosses this threshold.
// The waveform editor still works, but peak extraction on weak hardware (e.g. A7 Lite)
// can take a long time for multi-hour recordings.
export const LONG_RECORDING_WARNING_THRESHOLD_SEC = 2 * 60 * 60;
