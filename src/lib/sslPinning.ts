/**
 * SSL Certificate Pinning for Captivet Mobile
 *
 * In Expo managed workflow, we cannot use native certificate pinning libraries
 * directly. Instead, we implement a domain-allowlist approach that:
 *
 * 1. Validates all outbound requests target expected domains
 * 2. Ensures HTTPS is always used in production
 * 3. Rejects requests to unexpected or tampered URLs
 *
 * For full native certificate pinning (pinning SHA-256 of the server
 * certificate), eject to bare workflow and use:
 * - iOS:  TrustKit or URLSessionDelegate
 * - Android: OkHttp CertificatePinner via network_security_config.xml
 *
 * This module provides the managed-workflow-compatible layer.
 */

import { API_URL, SUPABASE_URL, R2_BUCKET_HOSTNAME } from '../config';

/** Trusted domains extracted from config at startup */
const TRUSTED_DOMAINS: string[] = [];

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function initTrustedDomains() {
  if (TRUSTED_DOMAINS.length > 0) return;

  const apiHost = extractHost(API_URL);
  const supabaseHost = extractHost(SUPABASE_URL);

  if (apiHost) TRUSTED_DOMAINS.push(apiHost);
  if (supabaseHost) TRUSTED_DOMAINS.push(supabaseHost);

  // Add the specific R2 bucket hostname if configured
  if (R2_BUCKET_HOSTNAME) TRUSTED_DOMAINS.push(R2_BUCKET_HOSTNAME);
}

/**
 * Validate that a URL targets a trusted domain and uses HTTPS.
 * Throws if the URL fails validation.
 */
export function validateRequestUrl(url: string): void {
  if (__DEV__) return; // Skip in development

  initTrustedDomains();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid request URL');
  }

  // Enforce HTTPS in production
  if (parsed.protocol !== 'https:') {
    throw new Error('Insecure connection rejected: HTTPS required');
  }

  // Allow presigned R2 upload URLs only for the configured bucket hostname
  if (R2_BUCKET_HOSTNAME && parsed.hostname === R2_BUCKET_HOSTNAME) {
    return;
  }

  // Check against trusted domains
  const isTrusted = TRUSTED_DOMAINS.some(
    (domain) => parsed.hostname === domain
  );

  if (!isTrusted) {
    throw new Error('Request to untrusted domain rejected');
  }
}

/**
 * Validate a presigned upload URL.
 * Presigned URLs can target R2/S3 storage buckets, so we validate the
 * structure rather than the exact domain.
 */
export function validateUploadUrl(url: string): void {
  if (__DEV__) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid upload URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Insecure upload URL rejected: HTTPS required');
  }

  // Validate hostname against the configured R2 bucket.
  // Fail-closed: if R2_BUCKET_HOSTNAME is not configured, reject all uploads.
  if (!R2_BUCKET_HOSTNAME) {
    throw new Error('Upload rejected: R2_BUCKET_HOSTNAME is not configured');
  }
  if (parsed.hostname !== R2_BUCKET_HOSTNAME) {
    throw new Error('Upload URL targets an untrusted storage domain');
  }

  // Verify presigned URL has a signature parameter (S3/R2 v4 signing)
  const hasSignature =
    parsed.searchParams.has('X-Amz-Signature') ||
    parsed.searchParams.has('X-Amz-Credential') ||
    parsed.searchParams.has('Signature');

  if (!hasSignature) {
    throw new Error('Upload URL is missing a presigned signature');
  }
}
