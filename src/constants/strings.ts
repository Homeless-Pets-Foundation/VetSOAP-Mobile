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
  /**
   * Compact banner shown while the overlay is hidden but uploads continue.
   * `active` is the 1-based position of the slot currently uploading —
   * derived from its index in the batch, NOT from the completed count, which
   * stops advancing after a failed slot (Codex P2, PR #143).
   */
  backgroundProgress: (active: number, total: number): string =>
    `Uploading ${Math.min(Math.max(active, 1), total)} of ${total}… Tap to view`,
  announceSingle: 'Upload in progress',
  announceMulti: (total: number): string => `Uploading ${total} recordings`,
} as const;

export const UPLOAD_RECOVERY_COPY = {
  submitAllBlockedTitle: 'Restart Upload First',
  submitAllBlockedBody:
    'One recording needs a confirmed safe restart. Open that patient and submit it individually before using Submit All.',
} as const;

export const UPLOAD_PREFLIGHT_TIMEOUT_COPY = {
  durable:
    "Captivet couldn't read the saved recording in time. Your audio is still saved. Fully close and reopen Captivet, then try again.",
  standard:
    "Captivet couldn't read the recording in time. Keep Captivet open and try the upload again.",
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
  signOutStillPending:
    'Still finishing the previous sign-out. Please try again in a moment.',
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

export const RECORDINGS_LIST_COPY = {
  searchPlaceholder: 'Search patient or client…',
  searchAccessibilityLabel: 'Search recordings by patient or client name',
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

export const QUALITY_ANALYTICS_COPY = {
  title: 'Clinic Quality',
  subtitle: '30-day clinic signals',
  empty: 'No clinic quality data yet.',
  unavailable: 'Clinic quality is unavailable right now.',
  retry: 'Retry',
  org: 'Practice',
  you: 'You',
  appointmentTypes: 'Appointment types',
  models: 'Models',
  providers: 'Providers',
  noRecordings: 'No recordings',
  metrics: {
    completed: 'Completed',
    averageLength: 'Avg length',
    uploadIssues: 'Upload issues',
    silentAudio: 'Silent audio',
    // A COUNT, not a rate: reprocessRate legitimately exceeds 1 (several
    // reprocess actions on one recording), so the tile used to render '200%'
    // above an alert reading 'Reprocessed 6 times across 5 recordings'. Tile
    // and alert both speak counts now; the denominator is already on screen
    // (Completed tile / 'N rec' row header). Do not relabel back to a rate.
    reprocesses: 'Reprocesses',
    soapEditRate: 'Edited notes',
    missingDetails: 'Missing details',
    // Distinct label from `missingDetails` on purpose. That one is a RATE in
    // SummaryBlock; this is the raw count in BreakdownRow, where a group can be
    // on screen solely because of it. One label meaning both a percentage and a
    // count is the trap the `Reprocesses` relabel above exists to avoid.
    missingDetailsCount: 'Awaiting details',
    p90Processing: '90% done by',
  },
  // Breakdown-row alerts. Each is its own wrapping line, so the reprocess
  // templates are capitalized — a line opening on a lowercase word reads as a
  // rendering fault. The other two open on a digit.
  //
  // The reprocess templates carry NO denominator. `reprocessCount` counts
  // audit-log reprocess actions in the window, which may target recordings
  // created before it, so "Reprocessed 6 times across 5 recordings" claimed a
  // relationship to `completedRecordings` that does not hold. Do not reintroduce
  // a denominator here without a server field for distinct recordings reprocessed.
  issues: {
    missingDetails: '{pct}% missing patient details',
    soapEdited: '{pct}% of notes edited',
    reprocessedOnce: 'Reprocessed once',
    reprocessedMany: 'Reprocessed {count} times',
  },
  // Server `label` is `z.string()` and accepts '', which rendered a blank row title.
  unlabeledGroup: 'Not specified',
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
  // Whole-review semantics: the card lists every unresolved reason BEFORE
  // either terminal action, so neither can silently hide untouched ones.
  reasonsTitle: 'What Captivet flagged',
  saveAndFinish: 'Save & finish review',
  keepCurrent: 'Keep current details',
  keepCurrentConfirmTitle: 'Keep current details?',
  keepCurrentConfirmBody:
    'Captivet will stop asking about these details for this recording. The current values are kept as-is.',
  keepCurrentConfirm: 'Keep current',
  missingPatientNameHint: 'Add the patient name to finish this review.',
  dismissFailed: 'Could not update this review. Please try again.',
} as const;

export const DELETE_RECORDING_COPY = {
  draftTitle: 'Delete Draft?',
  draftBody: 'This will permanently remove the draft from your account. This cannot be undone.',
  unavailableTitle: 'Delete unavailable recording?',
  unavailableBody:
    'This permanently deletes the server recording and any SOAP note or tasks generated from it. It cannot be undone. Deleting the row can also disrupt recovering this visit from another device.',
  colleagueSuffix:
    " This check only covers work saved on this tablet under your account — a colleague's own device may still hold a copy.",
  delete: 'Delete',
  deleteUnavailable: 'Delete unavailable recording',
  cancel: 'Cancel',
  checking: 'Checking this device for a saved copy…',
  unknownLocalState:
    'Captivet could not finish checking this device for a saved copy of this recording, so it will not offer to delete it.',
  recheck: 'Check again',
  resumeDraft: 'Resume saved recording',
  openSavedSessions: 'Open saved sessions',
  openRecovery: 'Open recovery',
  coordinate:
    'Ask the recording owner or an administrator to review this recording before starting a replacement visit.',
  deleteFailed: 'Could not delete this recording. Please try again.',
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

/**
 * Shared display labels for the five AI-fillable metadata fields. One source so
 * the review card, the attention feed, and accessibility copy agree.
 */
export const METADATA_FIELD_LABELS = {
  patientName: 'Patient',
  clientName: 'Client',
  species: 'Species',
  breed: 'Breed',
  appointmentType: 'Visit Type',
} as const;

/**
 * Attention Feed (2026-07-29 plan). Every count is qualified: the feed reads
 * ONE bounded page of the org's most recently updated recordings, so it is a
 * recent snapshot and never an authoritative backlog.
 */
export const ATTENTION_FEED_COPY = {
  sectionTitle: 'Needs Attention',
  openScreenAccessibilityLabel: 'Open Needs Attention',
  needsYouGroup: 'Needs you',
  acrossPracticeGroup: 'Across the practice',
  acrossPracticeSummary: (count: number): string =>
    `${count} across the practice`,
  acrossPracticeExpandHint: 'Read-only items for other clinicians',
  viewRecent: 'View recent attention',
  loading: 'Checking recent recordings…',

  // ── Zero-row states. Only `clean` is a positive claim, and it is feed-scoped.
  clean: 'No supported items need attention right now',
  cleanTruncated: (checked: number): string =>
    `No attention items found in the ${checked} most recently updated practice recordings checked.`,
  truncatedSummary: (items: number, checked: number): string =>
    `${items} attention item${items === 1 ? '' : 's'} found in the ${checked} most recently updated practice recordings checked.`,
  // Three variants because a row can be unclassifiable for either reason, and
  // naming the wrong one sends whoever investigates to the wrong place: a
  // recurring metadata-contract problem must not be reported as a clock problem.
  classificationPartial: 'Some recording timing data could not be checked',
  classificationPartialMetadata: 'Some recording details could not be checked',
  classificationPartialMixed: 'Some recordings could not be fully checked',
  localUnknown: 'Could not check all saved work',
  serverError: 'Could not check recent recordings.',
  coverageUnknown: 'Could not confirm how much of the practice was checked.',
  serverBlocked: 'Finish device setup to check recent practice recordings.',
  malformedResponse: 'Could not read the recordings response.',
  retry: 'Retry',

  // ── Row CTAs (never promise an action the viewer/server would reject).
  ctaReviewDetails: 'Review details',
  ctaOpenRecording: 'Open recording',
  ctaOpenDrafts: 'Open drafts',
  ctaOpenSavedSessions: 'Open saved sessions',
  ctaViewSavedWork: 'View saved work',
  ctaRecoveryHelp: 'Recovery help',
  // Rendered into ListItem's single-line `meta` slot, which ellipsizes: the
  // longer "the recording owner or an administrator can fix this" clipped
  // mid-word on a 1080px device. Keep any replacement under ~45 characters.
  readOnlyNote: 'Read-only — ask the owner or an admin.',
  moreIssues: (count: number): string => `+${count} more issue${count === 1 ? '' : 's'}`,
  moreWarnings: (count: number): string => `+${count} more warning${count === 1 ? '' : 's'}`,

  // ── Row titles.
  localDraftsTitle: 'Drafts on this device',
  localSavedSessionsTitle: 'Saved sessions on this device',

  // ── Reason copy. Values that appear here are already trimmed, whitespace-
  // collapsed, and bounded to the server field length by normalizeMetadataValue.
  //
  // There is deliberately NO multiple-patients string: discussing several
  // patients in one visit is routine here, so the alert was noise and was
  // removed from every surface (2026-07-29 owner decision). See the note in
  // `collectMetadataReasons`.
  conflictWithValues: (label: string, current: string, suggested: string): string =>
    `Record says '${current}'; Captivet heard '${suggested}' — review the ${label.toLowerCase()}.`,
  conflictGeneric: (label: string): string =>
    `Captivet found a different ${label.toLowerCase()} — review it.`,
  confirmWithCount: (count: number, patient: string): string =>
    `Captivet filled ${count} detail${count === 1 ? '' : 's'} for ${patient} — confirm they're right.`,
  confirmFallback: 'Captivet marked these details for review — check them.',
  missingDetails: "Captivet couldn't read the patient details — add them.",
  lowConfidenceWithValue: (label: string, value: string): string =>
    `Wasn't sure about ${label} — review '${value}'.`,
  lowConfidenceGeneric: (label: string): string =>
    `Captivet was unsure about ${label} — review it.`,
  notVerbatimPatientName:
    "Heard a patient name but couldn't confirm it in the audio.",
  notVerbatimField: (label: string): string =>
    `Heard a ${label.toLowerCase()} but couldn't confirm it in the audio.`,
  unclassifiedSuggestion: (label: string, value: string): string =>
    `Captivet suggested ${label} '${value}' — review it.`,
  recordingFailed: 'This recording could not be processed.',
  retryScheduled: 'Processing is scheduled to retry automatically.',
  stuckProcessing: 'Processing is taking longer than expected.',
  localDrafts: (count: number): string =>
    `${count} draft${count === 1 ? '' : 's'} saved on this device ${count === 1 ? 'has' : 'have'} not been sent.`,
  localSavedSessions: (count: number): string =>
    `${count} saved session${count === 1 ? '' : 's'} on this device ${count === 1 ? 'has' : 'have'} not been sent.`,
  localSupportStaffNote:
    'This account cannot submit recordings. Ask an owner, administrator, or veterinarian to recover this work on this tablet.',
} as const;

/**
 * Home recovery-priority banner for the support-staff recovery vault. Kept OUT
 * of the attention feed so preserved clinical work is never double-counted.
 */
export const SUPPORT_RECOVERY_BANNER_COPY = {
  message: (count: number): string =>
    `${count} preserved recording${count === 1 ? '' : 's'} from a support-staff account can be recovered on this tablet.`,
  unknownMessage: 'Could not check preserved support-staff recordings on this tablet.',
  cta: 'Open recovery',
  retry: 'Retry',
} as const;
