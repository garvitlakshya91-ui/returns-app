const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const logger = require('../utils/logger');

let s3Client = null;
function getClient() {
  if (s3Client) return s3Client;
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY) {
    logger.warn('R2 credentials not configured — storage disabled');
    return null;
  }
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY,
      secretAccessKey: process.env.R2_SECRET_KEY,
    },
  });
  return s3Client;
}

class StorageService {
  /**
   * Upload a file buffer to R2. Returns { key, url }.
   */
  static async upload(buffer, contentType, keyPrefix = 'uploads') {
    const client = getClient();
    if (!client) throw new Error('Storage not configured');

    const ext = (contentType.split('/')[1] || 'bin').toLowerCase();
    const key = `${keyPrefix}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;

    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    return {
      key,
      url: `${process.env.R2_PUBLIC_URL}/${key}`,
    };
  }

  static async uploadReturnPhoto(buffer, contentType, returnId) {
    return StorageService.upload(buffer, contentType, `returns/${returnId}/photos`);
  }

  static async uploadLabel(buffer, returnId) {
    return StorageService.upload(buffer, 'application/pdf', `returns/${returnId}/labels`);
  }

  static async delete(key) {
    const client = getClient();
    if (!client) return;
    await client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
  }

  /**
   * Generate a presigned PUT URL so the browser can upload directly to R2.
   */
  static async getPresignedUploadUrl({ returnId, contentType, contentLength }) {
    const client = getClient();
    if (!client) throw new Error('Storage not configured');

    const ext = (contentType.split('/')[1] || 'jpg').toLowerCase();
    const key = `returns/${returnId}/photos/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });

    return {
      uploadUrl,
      key,
      publicUrl: `${process.env.R2_PUBLIC_URL}/${key}`,
    };
  }

  static async getPresignedDownloadUrl(key, expiresIn = 3600) {
    const client = getClient();
    if (!client) throw new Error('Storage not configured');
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    });
    return getSignedUrl(client, command, { expiresIn });
  }

  /**
   * Delete every object for a given return (used on cancel / GDPR redact).
   */
  static async deleteAllForReturn(returnId) {
    const client = getClient();
    if (!client) return 0;

    const list = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: `returns/${returnId}/`,
    }));

    const keys = (list.Contents || []).map((obj) => obj.Key);
    for (const key of keys) {
      await StorageService.delete(key);
    }
    return keys.length;
  }

  static async deleteAllForShop(returnIds) {
    let total = 0;
    for (const id of returnIds) {
      total += await StorageService.deleteAllForReturn(id);
    }
    return total;
  }
}

module.exports = StorageService;
