// StorageService (Cloudflare R2 via the S3 SDK). The SDK is fully mocked —
// we assert on the commands the service builds and the URLs/keys it returns.

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY: 'access-key',
  R2_SECRET_KEY: 'secret-key',
  R2_BUCKET: 'returnflow-uploads',
  R2_PUBLIC_URL: 'https://cdn.returnflow.test',
};
const ENV_KEYS = Object.keys(R2_ENV);

let sdk;          // mocked @aws-sdk/client-s3 surface
let getSignedUrl; // mocked presigner
let StorageService;

function installSdkMocks() {
  const send = jest.fn().mockResolvedValue({});
  const S3Client = jest.fn().mockImplementation(function S3ClientMock(opts) {
    this.opts = opts;
    this.send = send;
  });
  // Each command is a tiny class that remembers its input so tests can
  // inspect exactly what the service asked the SDK to do.
  const mkCommand = (name) => jest.fn().mockImplementation(function Command(input) {
    this.__name = name;
    this.input = input;
  });
  sdk = {
    S3Client,
    send,
    PutObjectCommand: mkCommand('PutObject'),
    DeleteObjectCommand: mkCommand('DeleteObject'),
    GetObjectCommand: mkCommand('GetObject'),
    ListObjectsV2Command: mkCommand('ListObjectsV2'),
  };
  jest.doMock('@aws-sdk/client-s3', () => ({
    S3Client: sdk.S3Client,
    PutObjectCommand: sdk.PutObjectCommand,
    DeleteObjectCommand: sdk.DeleteObjectCommand,
    GetObjectCommand: sdk.GetObjectCommand,
    ListObjectsV2Command: sdk.ListObjectsV2Command,
  }));
  getSignedUrl = jest.fn().mockResolvedValue('https://signed.example/put');
  jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));
  // Keep pino from spawning a pretty-print transport on every module reset.
  jest.doMock('../../app/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
}

function setEnv(overrides = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, R2_ENV, overrides);
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

function load() {
  jest.resetModules();
  installSdkMocks();
  StorageService = require('../../app/services/StorageService');
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('StorageService — R2 not configured', () => {
  beforeEach(() => {
    setEnv({ R2_ACCOUNT_ID: undefined }); // any one missing credential disables storage
    load();
  });

  it('upload() throws and never constructs an S3 client', async () => {
    await expect(StorageService.upload(Buffer.from('x'), 'image/png')).rejects.toThrow('Storage not configured');
    expect(sdk.S3Client).not.toHaveBeenCalled();
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it('uploadReturnPhoto()/uploadLabel() surface the same error', async () => {
    await expect(StorageService.uploadReturnPhoto(Buffer.from('x'), 'image/jpeg', 'ret_1')).rejects.toThrow('Storage not configured');
    await expect(StorageService.uploadLabel(Buffer.from('x'), 'ret_1')).rejects.toThrow('Storage not configured');
  });

  it('presigned URL helpers throw', async () => {
    await expect(StorageService.getPresignedUploadUrl({ returnId: 'r', contentType: 'image/png', contentLength: 10 }))
      .rejects.toThrow('Storage not configured');
    await expect(StorageService.getPresignedDownloadUrl('k')).rejects.toThrow('Storage not configured');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('delete() is a silent no-op and deleteAllForReturn()/deleteAllForShop() report 0', async () => {
    await expect(StorageService.delete('returns/r/photos/a.png')).resolves.toBeUndefined();
    await expect(StorageService.deleteAllForReturn('r')).resolves.toBe(0);
    await expect(StorageService.deleteAllForShop(['a', 'b'])).resolves.toBe(0);
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it.each(['R2_ACCESS_KEY', 'R2_SECRET_KEY'])('is also disabled when only %s is missing', async (missing) => {
    setEnv({ [missing]: undefined });
    load();
    await expect(StorageService.upload(Buffer.from('x'), 'image/png')).rejects.toThrow('Storage not configured');
  });
});

describe('StorageService — configured', () => {
  beforeEach(() => {
    setEnv();
    load();
  });

  it('builds the S3 client against the account R2 endpoint with the configured credentials, once', async () => {
    await StorageService.upload(Buffer.from('a'), 'image/png');
    await StorageService.upload(Buffer.from('b'), 'image/png');
    expect(sdk.S3Client).toHaveBeenCalledTimes(1);
    expect(sdk.S3Client.mock.calls[0][0]).toEqual({
      region: 'auto',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    });
  });

  it('upload() writes an immutable public object under a unique key and returns the public URL', async () => {
    const buf = Buffer.from('png-bytes');
    const out = await StorageService.upload(buf, 'image/png', 'returns/ret_1/photos');

    expect(out.key).toMatch(/^returns\/ret_1\/photos\/\d+-[0-9a-f]{16}\.png$/);
    expect(out.url).toBe(`https://cdn.returnflow.test/${out.key}`);

    expect(sdk.PutObjectCommand).toHaveBeenCalledTimes(1);
    expect(sdk.PutObjectCommand.mock.calls[0][0]).toEqual({
      Bucket: 'returnflow-uploads',
      Key: out.key,
      Body: buf,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    // The exact command instance is what gets sent.
    expect(sdk.send).toHaveBeenCalledTimes(1);
    expect(sdk.send.mock.calls[0][0]).toBeInstanceOf(sdk.PutObjectCommand);
    expect(sdk.send.mock.calls[0][0].input.Key).toBe(out.key);
  });

  it('upload() defaults the key prefix to "uploads"', async () => {
    const out = await StorageService.upload(Buffer.from('x'), 'image/webp');
    expect(out.key).toMatch(/^uploads\/\d+-[0-9a-f]{16}\.webp$/);
  });

  it('upload() derives a lower-cased extension from the content type and falls back to .bin', async () => {
    expect((await StorageService.upload(Buffer.from('x'), 'image/JPEG')).key).toMatch(/\.jpeg$/);
    expect((await StorageService.upload(Buffer.from('x'), 'octet-stream')).key).toMatch(/\.bin$/);
  });

  it('generates distinct keys for back-to-back uploads', async () => {
    const a = await StorageService.upload(Buffer.from('x'), 'image/png');
    const b = await StorageService.upload(Buffer.from('x'), 'image/png');
    expect(a.key).not.toBe(b.key);
  });

  it('uploadReturnPhoto() namespaces the key under the return', async () => {
    const out = await StorageService.uploadReturnPhoto(Buffer.from('x'), 'image/jpeg', 'ret_42');
    expect(out.key).toMatch(/^returns\/ret_42\/photos\/\d+-[0-9a-f]{16}\.jpeg$/);
    expect(sdk.PutObjectCommand.mock.calls[0][0].ContentType).toBe('image/jpeg');
  });

  it('uploadLabel() stores a PDF under the return labels prefix', async () => {
    const out = await StorageService.uploadLabel(Buffer.from('%PDF'), 'ret_42');
    expect(out.key).toMatch(/^returns\/ret_42\/labels\/\d+-[0-9a-f]{16}\.pdf$/);
    expect(sdk.PutObjectCommand.mock.calls[0][0].ContentType).toBe('application/pdf');
    expect(out.url).toBe(`https://cdn.returnflow.test/${out.key}`);
  });

  it('propagates SDK failures from upload()', async () => {
    sdk.send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(StorageService.upload(Buffer.from('x'), 'image/png')).rejects.toThrow('AccessDenied');
  });

  it('delete() issues a DeleteObject for the key in the configured bucket', async () => {
    await StorageService.delete('returns/r/photos/a.png');
    expect(sdk.DeleteObjectCommand).toHaveBeenCalledWith({ Bucket: 'returnflow-uploads', Key: 'returns/r/photos/a.png' });
    expect(sdk.send.mock.calls[0][0]).toBeInstanceOf(sdk.DeleteObjectCommand);
  });

  it('getPresignedUploadUrl() presigns a 5-minute PUT with the declared type/length and returns the future public URL', async () => {
    const out = await StorageService.getPresignedUploadUrl({ returnId: 'ret_7', contentType: 'image/png', contentLength: 1234 });

    expect(out.uploadUrl).toBe('https://signed.example/put');
    expect(out.key).toMatch(/^returns\/ret_7\/photos\/\d+-[0-9a-f]{16}\.png$/);
    expect(out.publicUrl).toBe(`https://cdn.returnflow.test/${out.key}`);

    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [client, command, opts] = getSignedUrl.mock.calls[0];
    expect(client).toBe(sdk.S3Client.mock.instances[0]);
    expect(command).toBeInstanceOf(sdk.PutObjectCommand);
    expect(command.input).toEqual({ Bucket: 'returnflow-uploads', Key: out.key, ContentType: 'image/png', ContentLength: 1234 });
    expect(opts).toEqual({ expiresIn: 300 });
    // Presigning must not itself upload anything.
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it('getPresignedUploadUrl() falls back to .jpg when the content type has no subtype', async () => {
    const out = await StorageService.getPresignedUploadUrl({ returnId: 'r', contentType: 'image', contentLength: 1 });
    expect(out.key).toMatch(/\.jpg$/);
  });

  it('getPresignedDownloadUrl() presigns a GET, defaulting to a 1h expiry', async () => {
    getSignedUrl.mockResolvedValueOnce('https://signed.example/get');
    const url = await StorageService.getPresignedDownloadUrl('returns/r/labels/l.pdf');
    expect(url).toBe('https://signed.example/get');
    const [, command, opts] = getSignedUrl.mock.calls[0];
    expect(command).toBeInstanceOf(sdk.GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'returnflow-uploads', Key: 'returns/r/labels/l.pdf' });
    expect(opts).toEqual({ expiresIn: 3600 });

    await StorageService.getPresignedDownloadUrl('k', 60);
    expect(getSignedUrl.mock.calls[1][2]).toEqual({ expiresIn: 60 });
  });

  it('propagates presigner failures', async () => {
    getSignedUrl.mockRejectedValueOnce(new Error('sign failed'));
    await expect(StorageService.getPresignedDownloadUrl('k')).rejects.toThrow('sign failed');
  });

  it('deleteAllForReturn() lists the return prefix and deletes each object, returning the count', async () => {
    sdk.send.mockImplementation(async (cmd) => {
      if (cmd instanceof sdk.ListObjectsV2Command) {
        return { Contents: [{ Key: 'returns/ret_9/photos/a.png' }, { Key: 'returns/ret_9/labels/l.pdf' }] };
      }
      return {};
    });

    const n = await StorageService.deleteAllForReturn('ret_9');

    expect(n).toBe(2);
    expect(sdk.ListObjectsV2Command).toHaveBeenCalledWith({ Bucket: 'returnflow-uploads', Prefix: 'returns/ret_9/' });
    const deleted = sdk.DeleteObjectCommand.mock.calls.map((c) => c[0].Key);
    expect(deleted).toEqual(['returns/ret_9/photos/a.png', 'returns/ret_9/labels/l.pdf']);
    expect(sdk.send).toHaveBeenCalledTimes(3); // 1 list + 2 deletes
  });

  it('deleteAllForReturn() returns 0 and deletes nothing when the prefix is empty', async () => {
    sdk.send.mockResolvedValue({}); // no Contents key at all
    expect(await StorageService.deleteAllForReturn('ret_empty')).toBe(0);
    expect(sdk.DeleteObjectCommand).not.toHaveBeenCalled();
  });

  it('deleteAllForShop() sums the per-return counts', async () => {
    sdk.send.mockImplementation(async (cmd) => {
      if (cmd instanceof sdk.ListObjectsV2Command) {
        const n = cmd.input.Prefix.includes('ret_a') ? 3 : 1;
        return { Contents: Array.from({ length: n }, (_, i) => ({ Key: `${cmd.input.Prefix}f${i}` })) };
      }
      return {};
    });
    expect(await StorageService.deleteAllForShop(['ret_a', 'ret_b'])).toBe(4);
    expect(await StorageService.deleteAllForShop([])).toBe(0);
  });

  it('stops and propagates when a delete in the batch fails', async () => {
    sdk.send.mockImplementation(async (cmd) => {
      if (cmd instanceof sdk.ListObjectsV2Command) return { Contents: [{ Key: 'a' }, { Key: 'b' }] };
      throw new Error('delete failed');
    });
    await expect(StorageService.deleteAllForReturn('r')).rejects.toThrow('delete failed');
  });
});
