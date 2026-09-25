import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mediaUploadCompleteSchema, mediaUploadInitSchema } from "@map/shared/contracts";
import { config } from "../config";
import { query, transaction } from "../db";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { requireAuth, requireModerator, requireVerifiedContributor } from "../auth";
import {
  createPreviewUrl,
  createUploadUrl,
  deleteObject,
  getQuarantineMetadata,
  publishMediaObject,
  publicMediaUrl
} from "../storage";
import { enqueueMediaProcessing } from "../queue";
import { recordAudit } from "../audit";

function extensionForMime(mime: string) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "webp";
}

function mediaResponse(row: {
  id: string;
  privacy_status: string;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
  privacy_report: unknown;
  failure_code: string | null;
  created_at: Date;
  processed_at: Date | null;
}) {
  return {
    id: row.id,
    status: row.privacy_status,
    url: row.privacy_status === "ready" ? publicMediaUrl(row.public_object_key) : null,
    thumbnailUrl: row.privacy_status === "ready" ? publicMediaUrl(row.public_thumbnail_object_key) : null,
    privacyReport: row.privacy_report,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    processedAt: row.processed_at
  };
}

export async function mediaRoutes(app: FastifyInstance) {
  app.post("/media/uploads", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const input = mediaUploadInitSchema.parse(request.body);
    if (input.byteSize > config.MEDIA_MAX_BYTES) {
      throw new AppError(400, "VALIDATION_FAILED", `File exceeds ${config.MEDIA_MAX_BYTES} bytes`);
    }
    const id = randomUUID();
    const key = `quarantine/${request.user!.id}/${id}.${extensionForMime(input.mimeType)}`;
    await query(
      `INSERT INTO media_assets(id, owner_id, original_filename, mime_type, byte_size, quarantine_object_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, request.user!.id, input.filename, input.mimeType, input.byteSize, key]
    );
    const uploadUrl = await createUploadUrl(key, input.mimeType);
    return reply.code(201).send({ id, uploadUrl, expiresInSeconds: 600 });
  });

  app.post("/media/uploads/:id/complete", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = mediaUploadCompleteSchema.parse(request.body);

    // All database-visible side effects of completion converge on one row-lock
    // idempotency boundary: object validation, the quarantined -> processing
    // transition and the audit record commit (or are rejected) together, so a
    // retried or racing duplicate request can never validate twice or audit twice.
    // Job dispatch follows the commit with a deterministic job id, which collapses
    // any duplicate delivery to the single existing BullMQ job.
    const currentStatus = await transaction(async (client) => {
      const result = await client.query<{
        owner_id: string;
        byte_size: string;
        mime_type: string;
        quarantine_object_key: string;
        privacy_status: string;
      }>(
        `SELECT owner_id, byte_size, mime_type, quarantine_object_key, privacy_status
         FROM media_assets WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [params.id]
      );
      const media = result.rows[0];
      if (!media) throw notFound("Media not found");
      if (media.owner_id !== request.user!.id) throw forbidden();

      // The row lock serializes concurrent completions. A second caller observes the
      // already-claimed state and is answered idempotently without any side effect.
      if (media.privacy_status !== "quarantined") {
        return media.privacy_status;
      }

      // Object verification runs while holding the claim lock, inside the same
      // transaction: on failure nothing is transitioned and nothing is audited, and
      // duplicate requests never reach object storage at all.
      let metadata;
      try {
        metadata = await getQuarantineMetadata(media.quarantine_object_key);
      } catch {
        throw new AppError(409, "CONFLICT", "Uploaded object was not found in quarantine storage");
      }
      const actualBytes = Number(metadata.ContentLength ?? 0);
      const actualContentType = metadata.ContentType?.split(";")[0]?.trim();
      if (!actualBytes || actualBytes > config.MEDIA_MAX_BYTES || actualBytes !== Number(media.byte_size)) {
        throw new AppError(400, "VALIDATION_FAILED", "Uploaded object size does not match the declared size");
      }
      if (actualContentType && actualContentType !== media.mime_type) {
        throw new AppError(400, "VALIDATION_FAILED", "Uploaded object content type does not match the declared type");
      }

      await client.query(
        `UPDATE media_assets
         SET privacy_status = 'processing',
             privacy_report = $2::jsonb,
             failure_code = NULL,
             updated_at = now()
         WHERE id = $1 AND privacy_status = 'quarantined'`,
        [params.id, JSON.stringify({
          manualRegions: input.privacyRegions,
          containsPeopleOrPlates: input.containsPeopleOrPlates,
          rightsConfirmedAt: new Date().toISOString(),
          detector: "pending"
        })]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "media.processing_requested",
        resourceType: "media",
        resourceId: params.id,
        metadata: { regionCount: input.privacyRegions.length }
      });
      return "processing";
    });

    // Deterministic job id: a duplicate completion (e.g. a retried request after a
    // commit/enqueue failure window) is collapsed by BullMQ onto the existing job.
    // If Redis is unavailable, mark the claim failed so the upload stays retryable
    // via POST /media/:id/retry instead of being stranded in 'processing'.
    try {
      await enqueueMediaProcessing(params.id, `media-${params.id}`);
    } catch {
      await query(
        "UPDATE media_assets SET privacy_status = 'failed', failure_code = 'QUEUE_UNAVAILABLE', updated_at = now() WHERE id = $1",
        [params.id]
      );
      throw new AppError(503, "QUEUE_UNAVAILABLE", "Media processing queue is unavailable. Retry later.");
    }
    return { status: currentStatus };
  });

  app.get("/media/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query<{
      id: string; owner_id: string; privacy_status: string; public_object_key: string | null;
      public_thumbnail_object_key: string | null; privacy_report: unknown; failure_code: string | null;
      created_at: Date; processed_at: Date | null;
    }>(
      `SELECT id, owner_id, privacy_status, public_object_key, public_thumbnail_object_key,
              privacy_report, failure_code, created_at, processed_at
       FROM media_assets WHERE id = $1 AND deleted_at IS NULL`,
      [params.id]
    );
    const row = result.rows[0];
    if (!row) throw notFound("Media not found");
    if (row.owner_id !== request.user!.id && !["moderator", "admin"].includes(request.user!.role)) throw forbidden();
    return mediaResponse(row);
  });

  app.post("/media/:id/retry", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    // Same FOR UPDATE claim boundary as upload completion: racing retries serialize
    // on the row lock and only one can perform the failed/rejected -> processing
    // transition, so the processing job is enqueued at most once per retry generation.
    const claim = await transaction(async (client) => {
      const result = await client.query<{ owner_id: string; privacy_status: string }>(
        `SELECT owner_id, privacy_status FROM media_assets
         WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [params.id]
      );
      const row = result.rows[0];
      if (!row) throw notFound("Media not found");
      if (row.owner_id !== request.user!.id && !["moderator", "admin"].includes(request.user!.role)) throw forbidden();
      if (!["failed", "rejected"].includes(row.privacy_status)) {
        // A concurrent retry already claimed the asset; answer idempotently instead
        // of performing a second transition/enqueue.
        return { status: row.privacy_status, jobId: null as string | null };
      }
      const transitioned = await client.query<{ updated_at: Date }>(
        `UPDATE media_assets
         SET privacy_status = 'processing', failure_code = NULL, updated_at = now()
         WHERE id = $1 AND privacy_status IN ('failed', 'rejected')
         RETURNING updated_at`,
        [params.id]
      );
      // The transition timestamp identifies this retry generation: concurrent
      // duplicates of the same click share it and collapse to one job, while each
      // later retry gets a fresh id instead of reusing the previous failed job.
      return { status: "processing", jobId: `media-${params.id}-retry-${transitioned.rows[0]!.updated_at.getTime()}` };
    });
    if (claim.status !== "processing" || !claim.jobId) {
      return { status: claim.status };
    }
    try {
      await enqueueMediaProcessing(params.id, claim.jobId);
    } catch {
      await query(
        "UPDATE media_assets SET privacy_status = 'failed', failure_code = 'QUEUE_UNAVAILABLE', updated_at = now() WHERE id = $1",
        [params.id]
      );
      throw new AppError(503, "QUEUE_UNAVAILABLE", "Media processing queue is unavailable. Retry later.");
    }
    return { status: "processing" };
  });

  app.get("/media/:id/preview", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query<{ processed_object_key: string | null; privacy_status: string }>(
      "SELECT processed_object_key, privacy_status FROM media_assets WHERE id = $1 AND deleted_at IS NULL",
      [params.id]
    );
    const media = result.rows[0];
    if (!media) throw notFound("Media not found");
    if (!media.processed_object_key) throw conflict("Processed preview is not available");
    await query(
      `INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'media.preview_viewed', 'media', $2, '{}'::jsonb)`,
      [request.user!.id, params.id]
    );
    return {
      status: media.privacy_status,
      url: await createPreviewUrl(media.processed_object_key),
      expiresInSeconds: 600
    };
  });

  app.post("/media/:id/privacy-approve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query<{
      id: string;
      privacy_status: string;
      processed_object_key: string | null;
      thumbnail_object_key: string | null;
      public_object_key: string | null;
      public_thumbnail_object_key: string | null;
    }>(
      `SELECT id, privacy_status, processed_object_key, thumbnail_object_key,
              public_object_key, public_thumbnail_object_key
       FROM media_assets WHERE id = $1 AND deleted_at IS NULL`,
      [params.id]
    );
    const media = result.rows[0];
    if (!media) throw notFound("Media not found");
    if (media.privacy_status !== "manual_review" || !media.processed_object_key) {
      throw conflict("Media is not waiting for manual privacy approval");
    }

    const publicKey = `media/${params.id}.webp`;
    const thumbnailKey = `media/${params.id}.thumb.webp`;
    try {
      await publishMediaObject(media.processed_object_key, publicKey);
      if (media.thumbnail_object_key) await publishMediaObject(media.thumbnail_object_key, thumbnailKey);

      await transaction(async (client) => {
        await client.query(
          `UPDATE media_assets
           SET privacy_status = 'ready', public_object_key = $2,
               public_thumbnail_object_key = $3, processed_at = now(), updated_at = now()
           WHERE id = $1`,
          [params.id, publicKey, media.thumbnail_object_key ? thumbnailKey : null]
        );
        await recordAudit(client, {
          actorId: request.user!.id,
          action: "media.privacy_approved",
          resourceType: "media",
          resourceId: params.id
        });
      });
    } catch (error) {
      await Promise.allSettled([
        deleteObject(config.S3_PUBLIC_BUCKET, publicKey),
        media.thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, thumbnailKey) : Promise.resolve()
      ]);
      throw error;
    }

    return { status: "ready", url: publicMediaUrl(publicKey), thumbnailUrl: media.thumbnail_object_key ? publicMediaUrl(thumbnailKey) : null };
  });

  app.delete("/media/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query<{
      id: string;
      owner_id: string;
      quarantine_object_key: string;
      processed_object_key: string | null;
      thumbnail_object_key: string | null;
      public_object_key: string | null;
      public_thumbnail_object_key: string | null;
    }>(
      `SELECT id, owner_id, quarantine_object_key, processed_object_key, thumbnail_object_key,
              public_object_key, public_thumbnail_object_key
       FROM media_assets WHERE id = $1 AND deleted_at IS NULL`,
      [params.id]
    );
    const media = result.rows[0];
    if (!media) throw notFound("Media not found");
    if (media.owner_id !== request.user!.id && !["moderator", "admin"].includes(request.user!.role)) throw forbidden();

    const publishedReference = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM revision_media rm
         JOIN map_features mf ON mf.current_revision_id = rm.revision_id
         WHERE rm.media_id = $1
           AND mf.status = 'published'
           AND mf.deleted_at IS NULL
       ) AS exists`,
      [params.id]
    );
    if (publishedReference.rows[0]?.exists) {
      throw conflict("Media attached to published content cannot be deleted separately");
    }

    await transaction(async (client) => {
      await client.query("UPDATE media_assets SET privacy_status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1", [params.id]);
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "media.deleted",
        resourceType: "media",
        resourceId: params.id
      });
    });

    const removals = [
      deleteObject(config.S3_QUARANTINE_BUCKET, media.quarantine_object_key),
      media.processed_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, media.processed_object_key) : Promise.resolve(),
      media.public_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, media.public_object_key) : Promise.resolve(),
      media.public_thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, media.public_thumbnail_object_key) : Promise.resolve(),
      media.thumbnail_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, media.thumbnail_object_key) : Promise.resolve()
    ];
    await Promise.allSettled(removals);
    return { status: "deleted" };
  });
}
