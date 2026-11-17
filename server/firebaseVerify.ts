import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
}

export interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: Record<string, string> = {};
let certsExpiresAt = 0;

function loadProjectConfig(): FirebaseAppletConfig {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw) as FirebaseAppletConfig;
}

async function getGooglePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now < certsExpiresAt && Object.keys(cachedCerts).length > 0) {
    return cachedCerts;
  }

  const res = await fetch(FIREBASE_CERTS_URL);
  if (!res.ok) {
    throw new Error(`Unable to fetch Firebase public keys (HTTP ${res.status}).`);
  }

  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  cachedCerts = (await res.json()) as Record<string, string>;
  certsExpiresAt = now + Math.max(60, maxAgeSec) * 1000;
  return cachedCerts;
}

function base64UrlDecode(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing Firebase authentication token.');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported JWT algorithm or missing key ID.');
  }

  const config = loadProjectConfig();
  const nowSec = Math.floor(Date.now() / 1000);

  if (payload.aud !== config.projectId) {
    throw new Error('Token audience does not match FACON HOST project.');
  }
  if (payload.iss !== `https://securetoken.google.com/${config.projectId}`) {
    throw new Error('Token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
    throw new Error('Invalid subject claim in token.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 30) {
    throw new Error('Firebase session expired. Refresh or sign in again.');
  }
  if (payload.email_verified !== true) {
    throw new Error('Verified email address required to operate backend runners.');
  }

  const certs = await getGooglePublicCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    // Force refresh once in case of key rotation
    certsExpiresAt = 0;
    const freshCerts = await getGooglePublicCerts();
    const freshPem = freshCerts[header.kid];
    if (!freshPem) {
      throw new Error('Unable to match Firebase signing certificate.');
    }
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    if (!verifier.verify(freshPem, base64UrlDecode(signatureB64))) {
      throw new Error('Invalid Firebase ID token signature.');
    }
  } else {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    if (!verifier.verify(certPem, base64UrlDecode(signatureB64))) {
      throw new Error('Invalid Firebase ID token signature.');
    }
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    emailVerified: true,
  };
}
