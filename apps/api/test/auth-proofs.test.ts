/**
 * Adapter-contract tests, NOT full real-authenticator acceptance.
 * WebAuthn library generate/verify functions are mocked only to assert the
 * exact security parameters passed and the returned-field allowlist/error
 * normalization. A later browser integration gate exercises real crypto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AuthProofError } from '../src/auth/proofs.js';

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  validateAuthOriginConfig,
  generatePasskeyRegistration,
  generatePasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyPasskeyAuthentication,
  createWalletLoginMessage,
  verifyWalletLoginProof,
} from '../src/auth/proofs.js';

const mockGenReg = vi.mocked(generateRegistrationOptions);
const mockGenAuth = vi.mocked(generateAuthenticationOptions);
const mockVerifyReg = vi.mocked(verifyRegistrationResponse);
const mockVerifyAuth = vi.mocked(verifyAuthenticationResponse);

const DEV = validateAuthOriginConfig({
  origin: 'http://localhost:5173',
  rpId: 'localhost',
  environment: 'development',
});
const PROD = validateAuthOriginConfig({
  origin: 'https://openarc.example',
  rpId: 'openarc.example',
  environment: 'production',
});

const HANDLE = Buffer.alloc(32, 7).toString('base64url'); // 43 chars canonical
const CHALLENGE = Buffer.alloc(24, 1).toString('base64url');
const CRED_ID = Buffer.from('credential-1').toString('base64url');

// Public EIP55 fixture (contains alphabetic checksum chars) for parser-only rejection.
const EIP55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const toggleChecksumChar = (addr: string): string => {
  for (let i = 2; i < addr.length; i += 1) {
    const ch = addr[i]!;
    if (/[a-fA-F]/.test(ch)) {
      return addr.slice(0, i) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + addr.slice(i + 1);
    }
  }
  throw new Error('no alphabetic char');
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateAuthOriginConfig', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['dev localhost http', { origin: 'http://localhost:5173', rpId: 'localhost', environment: 'development' }, true],
    ['dev 127.0.0.1 http', { origin: 'http://127.0.0.1:3000', rpId: '127.0.0.1', environment: 'development' }, true],
    ['prod https', { origin: 'https://openarc.example', rpId: 'openarc.example', environment: 'production' }, true],
    ['prod localhost https', { origin: 'https://localhost', rpId: 'localhost', environment: 'production' }, false],
    ['prod 127.0.0.1 https', { origin: 'https://127.0.0.1', rpId: '127.0.0.1', environment: 'production' }, false],
    ['prod http', { origin: 'http://openarc.example', rpId: 'openarc.example', environment: 'production' }, false],
    ['dev non-loopback http', { origin: 'http://evil.example', rpId: 'evil.example', environment: 'development' }, false],
    ['trailing slash', { origin: 'https://openarc.example/', rpId: 'openarc.example', environment: 'production' }, false],
    ['with path', { origin: 'https://openarc.example/x', rpId: 'openarc.example', environment: 'production' }, false],
    ['with query', { origin: 'https://openarc.example?a=1', rpId: 'openarc.example', environment: 'production' }, false],
    ['with credentials', { origin: 'https://u:p@openarc.example', rpId: 'openarc.example', environment: 'production' }, false],
    ['rpId wildcard', { origin: 'https://openarc.example', rpId: '*.example', environment: 'production' }, false],
    ['rpId parent widen', { origin: 'https://openarc.example', rpId: 'example', environment: 'production' }, false],
    ['rpId mismatch', { origin: 'https://openarc.example', rpId: 'other.example', environment: 'production' }, false],
    ['non-url', { origin: 'not a url', rpId: 'x', environment: 'development' }, false],
    ['extra field', { origin: 'https://openarc.example', rpId: 'openarc.example', environment: 'production', x: 1 }, false],
    ['bad env', { origin: 'https://openarc.example', rpId: 'openarc.example', environment: 'staging' }, false],
  ];
  it.each(cases)('%s', (_name, input, ok) => {
    if (ok) expect(validateAuthOriginConfig(input)).toBeTruthy();
    else expect(() => validateAuthOriginConfig(input)).toThrow(AuthProofError);
  });
});

describe('passkey options (adapter contract)', () => {
  it('registration uses exact RP/user/security params', async () => {
    mockGenReg.mockResolvedValue({ challenge: CHALLENGE } as never);
    await generatePasskeyRegistration(HANDLE, DEV);
    expect(mockGenReg).toHaveBeenCalledTimes(1);
    const arg = mockGenReg.mock.calls[0]![0]!;
    expect(arg.rpName).toBe('OpenArc');
    expect(arg.rpID).toBe('localhost');
    expect(arg.userName).toBe(`OpenArc ${HANDLE.slice(0, 8)}`);
    expect(arg.userDisplayName).toBe(`OpenArc ${HANDLE.slice(0, 8)}`);
    expect(arg.attestationType).toBe('none');
    expect(arg.supportedAlgorithmIDs).toEqual([-7, -257]);
    expect(arg.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(Buffer.from(arg.userID as Uint8Array).toString('base64url')).toBe(HANDLE);
    expect(arg).not.toHaveProperty('requestId');
  });

  it('authentication is discoverable, no allowCredentials enumeration', async () => {
    mockGenAuth.mockResolvedValue({ challenge: CHALLENGE } as never);
    await generatePasskeyAuthentication(PROD);
    const arg = mockGenAuth.mock.calls[0]![0]!;
    expect(arg.rpID).toBe('openarc.example');
    expect(arg.userVerification).toBe('required');
    expect(arg.allowCredentials).toEqual([]);
  });

  const badHandles: unknown[] = [
    'too-short',
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}!`,
    123,
    null,
  ];
  it.each(badHandles)('registration rejects bad handle %#', async (h) => {
    await expect(
      generatePasskeyRegistration(h as string, DEV),
    ).rejects.toThrow(AuthProofError);
    expect(mockGenReg).not.toHaveBeenCalled();
  });

  it('normalizes library throw', async () => {
    mockGenReg.mockRejectedValue(new Error('raw detail'));
    await expect(generatePasskeyRegistration(HANDLE, DEV)).rejects.toThrow(
      'AUTH_PROOF_INVALID',
    );
  });

  it('accepts 43-char handle at bound and rejects 44 chars', async () => {
    mockGenReg.mockResolvedValue({ challenge: CHALLENGE } as never);
    await expect(
      generatePasskeyRegistration(HANDLE, DEV),
    ).resolves.toBeTruthy();
    await expect(
      generatePasskeyRegistration(`${HANDLE}x`, DEV),
    ).rejects.toThrow(AuthProofError);
  });
});

describe('verifyPasskeyRegistration (adapter contract)', () => {
  const base = () => ({
    id: CRED_ID,
    rawId: CRED_ID,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from('x').toString('base64url'),
      attestationObject: Buffer.from('y').toString('base64url'),
    },
    clientExtensionResults: {},
  });

  it('accepts canonical 16-char (12 bytes) and 256-char challenges, rejects 15/257', async () => {
    const minChallenge = Buffer.alloc(12).toString('base64url'); // canonical 16 chars
    const maxChallenge = Buffer.alloc(192).toString('base64url'); // canonical 256 chars
    expect(minChallenge).toHaveLength(16);
    expect(maxChallenge).toHaveLength(256);
    mockVerifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: CRED_ID, publicKey: new Uint8Array([1]), counter: 0, transports: [] },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    } as never);
    await expect(verifyPasskeyRegistration(base(), minChallenge, DEV)).resolves.toBeTruthy();
    await expect(verifyPasskeyRegistration(base(), maxChallenge, DEV)).resolves.toBeTruthy();
    await expect(verifyPasskeyRegistration(base(), 'a'.repeat(15), DEV)).rejects.toThrow(
      AuthProofError,
    );
    await expect(verifyPasskeyRegistration(base(), 'a'.repeat(257), DEV)).rejects.toThrow(
      AuthProofError,
    );
    // Canonical decode/re-encode: an in-bounds encoded string that decodes to
    // 12 bytes but is not its own canonical re-encoding must be rejected.
    const nonCanonical = `${minChallenge}A`;
    expect(nonCanonical).toHaveLength(17);
    expect(Buffer.from(nonCanonical, 'base64url')).toHaveLength(12);
    expect(Buffer.from(nonCanonical, 'base64url').toString('base64url')).not.toBe(nonCanonical);
    await expect(verifyPasskeyRegistration(base(), nonCanonical, DEV)).rejects.toThrow(
      AuthProofError,
    );
  });

  it('passes exact challenge/origin/rpId and UV, returns allowlisted proof only', async () => {
    mockVerifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: base().id,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    } as never);
    const proof = await verifyPasskeyRegistration(base(), CHALLENGE, DEV);
    const arg = mockVerifyReg.mock.calls[0]![0]!;
    expect(arg.expectedChallenge).toBe(CHALLENGE);
    expect(arg.expectedOrigin).toBe('http://localhost:5173');
    expect(arg.expectedRPID).toBe('localhost');
    expect(arg.requireUserVerification).toBe(true);
    expect(arg.supportedAlgorithmIDs).toEqual([-7, -257]);
    expect(proof).toMatchObject({
      credentialId: base().id,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: ['internal'],
    });
    expect(Object.keys(proof).sort()).toEqual([
      'backedUp',
      'counter',
      'credentialId',
      'deviceType',
      'publicKey',
      'transports',
    ]);
    expect(proof).not.toHaveProperty('clientDataJSON');
    expect(proof).not.toHaveProperty('signature');
  });

  it('accepts top-level authenticatorAttachment and omitted clientExtensionResults', async () => {
    mockVerifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: CRED_ID,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    } as never);
    const withoutExt = { ...base() } as Record<string, unknown>;
    delete withoutExt.clientExtensionResults;
    const resp = { ...withoutExt, authenticatorAttachment: 'platform' };
    const proof = await verifyPasskeyRegistration(resp, CHALLENGE, DEV);
    expect(proof.credentialId).toBe(CRED_ID);
  });

  const malformed: Array<[string, unknown]> = [
    ['id != rawId', { ...base(), rawId: 'other' }],
    ['bad type', { ...base(), type: 'nope' }],
    ['unknown top field', { ...base(), signature: 'x' }],
    ['privatePrompt wrapper', { ...base(), privatePrompt: true }],
    ['bad transport', { ...base(), response: { ...base().response, transports: ['serial'] } }],
    ['excess transports', { ...base(), response: { ...base().response, transports: Array(9).fill('usb') } }],
    ['bad clientExtensionResults', { ...base(), clientExtensionResults: { credProps: { rk: 'yes' } } }],
    ['wrong nested attachment', { ...base(), clientExtensionResults: { authenticatorAttachment: 'platform' } }],
    ['bad top-level attachment', { ...base(), authenticatorAttachment: 'nope' }],
    ['oversized clientDataJSON', { ...base(), response: { ...base().response, clientDataJSON: 'a'.repeat(8193) } }],
    ['noncanonical id padding', { ...base(), id: `${CRED_ID}==`, rawId: `${CRED_ID}==` }],
    ['id trailing newline', { ...base(), id: `${CRED_ID}\n`, rawId: `${CRED_ID}\n` }],
  ];
  it.each(malformed)('rejects %s before verifier', async (_n, resp) => {
    await expect(
      verifyPasskeyRegistration(resp, CHALLENGE, DEV),
    ).rejects.toThrow(AuthProofError);
    expect(mockVerifyReg).not.toHaveBeenCalled();
  });

  it.each([
    ['verified false', { verified: false }],
    ['missing info', { verified: true }],
  ])('rejects %s', async (_n, v) => {
    mockVerifyReg.mockResolvedValue(v as never);
    await expect(
      verifyPasskeyRegistration(base(), CHALLENGE, DEV),
    ).rejects.toThrow(AuthProofError);
  });

  it('normalizes library throw', async () => {
    mockVerifyReg.mockRejectedValue(new Error('raw'));
    await expect(
      verifyPasskeyRegistration(base(), CHALLENGE, DEV),
    ).rejects.toThrow('AUTH_PROOF_INVALID');
  });

  it.each(['', 'x', 'a'.repeat(15), 'a'.repeat(257), 'has space'])(
    'rejects bad challenge %#',
    async (c) => {
      await expect(
        verifyPasskeyRegistration(base(), c, DEV),
      ).rejects.toThrow(AuthProofError);
    },
  );
});

describe('verifyPasskeyAuthentication (adapter contract)', () => {
  const stored = {
    credentialId: CRED_ID,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 5,
    deviceType: 'multiDevice' as const,
    backedUp: true,
    transports: ['internal'] as never[],
  };
  const auth = () => ({
    id: CRED_ID,
    rawId: CRED_ID,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from('x').toString('base64url'),
      authenticatorData: Buffer.from('y').toString('base64url'),
      signature: Buffer.from('z').toString('base64url'),
    },
    clientExtensionResults: {},
  });

  it('propagates credential/counter and exact params, returns only counter+backedUp', async () => {
    mockVerifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 6,
        credentialBackedUp: true,
        credentialDeviceType: 'multiDevice',
        credentialID: CRED_ID,
      },
    } as never);
    const out = await verifyPasskeyAuthentication(auth(), CHALLENGE, DEV, stored);
    const arg = mockVerifyAuth.mock.calls[0]![0]!;
    expect(arg.expectedChallenge).toBe(CHALLENGE);
    expect(arg.expectedOrigin).toBe('http://localhost:5173');
    expect(arg.expectedRPID).toBe('localhost');
    expect(arg.requireUserVerification).toBe(true);
    expect(arg.credential).toMatchObject({
      id: CRED_ID,
      counter: 5,
    });
    expect(Object.keys(out).sort()).toEqual(['backedUp', 'newCounter']);
    expect(out).toEqual({ newCounter: 6, backedUp: true });
  });

  it.each([
    ['id mismatch', {
      ...auth(),
      id: Buffer.from('other').toString('base64url'),
      rawId: Buffer.from('other').toString('base64url'),
    }],
    ['unknown response field', { ...auth(), attestationObject: 'x' }],
    ['bad top-level attachment', { ...auth(), authenticatorAttachment: 'nope' }],
  ])('rejects %s before verifier', async (_n, resp) => {
    await expect(
      verifyPasskeyAuthentication(resp, CHALLENGE, DEV, stored),
    ).rejects.toThrow(AuthProofError);
    expect(mockVerifyAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['bad stored counter', { ...stored, counter: -1 }],
    ['stored excess field', { ...stored, secret: 'x' }],
    ['oversized stored key', { ...stored, publicKey: new Uint8Array(2049) }],
  ])('rejects stored %s before verifier', async (_n, cred) => {
    await expect(
      verifyPasskeyAuthentication(auth(), CHALLENGE, DEV, cred as never),
    ).rejects.toThrow(AuthProofError);
    expect(mockVerifyAuth).not.toHaveBeenCalled();
  });

  it('accepts multiDevice backedUp=false and rejects immutable-field changes', async () => {
    mockVerifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 7,
        credentialBackedUp: false,
        credentialDeviceType: 'multiDevice',
        credentialID: CRED_ID,
      },
    } as never);
    await expect(
      verifyPasskeyAuthentication(auth(), CHALLENGE, DEV, stored),
    ).resolves.toEqual({ newCounter: 7, backedUp: false });

    const mismatches: unknown[] = [
      { credentialDeviceType: 'singleDevice', credentialID: CRED_ID },
      { credentialDeviceType: 'multiDevice', credentialID: Buffer.from('other').toString('base64url') },
    ];
    for (const m of mismatches) {
      mockVerifyAuth.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 8, credentialBackedUp: true, ...(m as object) },
      } as never);
      await expect(
        verifyPasskeyAuthentication(auth(), CHALLENGE, DEV, stored),
      ).rejects.toThrow(AuthProofError);
    }
  });

  it('rejects singleDevice stored with backedUp true', async () => {
    await expect(
      verifyPasskeyAuthentication(
        auth(),
        CHALLENGE,
        DEV,
        { ...stored, deviceType: 'singleDevice', backedUp: true } as never,
      ),
    ).rejects.toThrow(AuthProofError);
    expect(mockVerifyAuth).not.toHaveBeenCalled();
  });

  it('rejects verified false and normalizes throw', async () => {
    mockVerifyAuth.mockResolvedValue({ verified: false } as never);
    await expect(
      verifyPasskeyAuthentication(auth(), CHALLENGE, DEV, stored),
    ).rejects.toThrow(AuthProofError);
    mockVerifyAuth.mockRejectedValue(new Error('raw'));
    await expect(
      verifyPasskeyAuthentication(auth(), CHALLENGE, DEV, stored),
    ).rejects.toThrow('AUTH_PROOF_INVALID');
  });

  it('accepts top-level authenticatorAttachment', async () => {
    mockVerifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 6,
        credentialBackedUp: true,
        credentialDeviceType: 'multiDevice',
        credentialID: CRED_ID,
      },
    } as never);
    const out = await verifyPasskeyAuthentication(
      { ...auth(), authenticatorAttachment: 'cross-platform' },
      CHALLENGE,
      DEV,
      stored,
    );
    expect(out).toEqual({ newCounter: 6, backedUp: true });
  });
});

describe('wallet login (EOA SIWE)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const now = new Date('2026-09-11T12:00:00Z');
  const ctx = () => ({
    address: account.address,
    nonce: 'a'.repeat(32),
    issuedAt: new Date(now.getTime() - 1000),
    config: PROD,
  });

  it('happy path verifies and returns lowercase checksum address', async () => {
    const c = ctx();
    const message = createWalletLoginMessage(c);
    expect(message).toContain('Sign in to OpenArc. This does not authorize payments.');
    expect(message).toContain('Chain ID: 5042002');
    const signature = await account.signMessage({ message });
    const result = await verifyWalletLoginProof(message, signature, c, now);
    expect(result).toBe(account.address.toLowerCase());
  });

  const bad: Array<[string, (m: string, c: ReturnType<typeof ctx>, t: Date) => unknown[]]> = [
    ['wrong signature', (m) => [m, `0x${'11'.repeat(65)}`, undefined]],
    ['wrong message', (m) => [`${m} tampered`, undefined, undefined]],
    ['wrong address', (m, c) => [m, undefined, { ...c, address: '0x' + '1'.repeat(40) }]],
    ['wrong nonce', (m, c) => [m, undefined, { ...c, nonce: 'b'.repeat(32) }]],
    ['wrong origin', (m, c) => [m, undefined, { ...c, config: DEV }]],
    ['expired', (m, c, t) => [m, undefined, undefined, new Date(t.getTime() + 6 * 60 * 1000)]],
    ['future issuedAt', (m, c, t) => [m, undefined, { ...c, issuedAt: new Date(t.getTime() + 1000) }]],
    ['invalid date', (m, c) => [m, undefined, { ...c, issuedAt: new Date(NaN) }]],
    ['empty proof', () => ['', '']],
    ['injected context field', (m, c) => [m, undefined, { ...c, privatePrompt: true }]],
    ['wrong chain text', (m) => [`${m}\n`.replace('5042002', '1'), undefined, undefined]],
    ['bad checksum address', (m, c) => [m, undefined, { ...c, address: toggleChecksumChar(EIP55) }]],
  ];

  it.each(bad)('rejects %s', async (_n, build) => {
    const c = ctx();
    const message = createWalletLoginMessage(c);
    const signature = await account.signMessage({ message });
    const [m, s, override, t] = build(message, c, now);
    await expect(
      verifyWalletLoginProof(
        (m as string) ?? message,
        (s as string) ?? signature,
        (override as ReturnType<typeof ctx>) ?? c,
        (t as Date) ?? now,
      ),
    ).rejects.toThrow(AuthProofError);
  });

  it('rejects wrong signer (different ephemeral account)', async () => {
    const c = ctx();
    const message = createWalletLoginMessage(c);
    const signature = await other.signMessage({ message });
    await expect(
      verifyWalletLoginProof(message, signature, c, now),
    ).rejects.toThrow(AuthProofError);
  });

  it('rejects exactly at expiry and accepts just before', async () => {
    const c = ctx();
    const message = createWalletLoginMessage(c);
    const signature = await account.signMessage({ message });
    const expiry = new Date(c.issuedAt.getTime() + 5 * 60 * 1000);
    await expect(
      verifyWalletLoginProof(
        message,
        signature,
        c,
        new Date(expiry.getTime() - 1),
      ),
    ).resolves.toBe(account.address.toLowerCase());
    await expect(
      verifyWalletLoginProof(message, signature, c, expiry),
    ).rejects.toThrow(AuthProofError);
  });

  it('rejects non-65-byte and newline-terminated signatures', async () => {
    const c = ctx();
    const message = createWalletLoginMessage(c);
    const signature = await account.signMessage({ message });
    await expect(
      verifyWalletLoginProof(message, `${signature}0`, c, now),
    ).rejects.toThrow(AuthProofError);
    await expect(
      verifyWalletLoginProof(message, `${signature}\n`, c, now),
    ).rejects.toThrow(AuthProofError);
  });

  it('errors never echo private input', async () => {
    const c = ctx();
    const message = createWalletLoginMessage(c);
    let caught: Error | undefined;
    await verifyWalletLoginProof(message, '0xdead', c, now).catch((e) => {
      caught = e as Error;
    });
    expect(caught).toBeInstanceOf(AuthProofError);
    expect(caught!.message).toBe('AUTH_PROOF_INVALID');
    expect(caught!.message).not.toContain('dead');
  });

  it('chainId is fixed and contract-wallet messaging absent', () => {
    const m = createWalletLoginMessage(ctx());
    expect(m).toContain('Chain ID: 5042002');
    expect(m).toContain('Version: 1');
    expect(m).not.toContain('Resources');
  });
});
