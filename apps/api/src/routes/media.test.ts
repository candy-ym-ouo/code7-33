import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors";
import { mediaRoutes } from "./media";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  clientQuery: vi.fn(),
  getQuarantineMetadata: vi.fn(),
  enqueueMediaProcessing: vi.fn()
}));

vi.mock("../config", () => ({
  config: {
    MEDIA_MAX_BYTES: 10 * 1024 * 1024,
    S3_PUBLIC_BUCKET: "public-bucket",
    S3_QUARANTINE_BUCKET: "quarantine-bucket",
    PUBLIC_MEDIA_BASE_URL: "https://media.example.com"
  }
}));

vi.mock("../db", () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));

vi.mock("../auth", () => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111", // OWNER_ID
    email: "owner@example.com",
    displayName: "Owner",
    role: "contributor",
    status: "active",
    emailVerified: true
  };
  const inject = async (request: { user?: unknown }) => {
    request.user = user;
  };
  return {
    requireAuth: inject,
    requireVerifiedContributor: inject,
    requireModerator: inject
  };
});

vi.mock("../storage", () => ({
  createPreviewUrl: vi.fn(),
  createUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getQuarantineMetadata: mocks.getQuarantineMetadata,
  publishMediaObject: vi.fn(),
  publicMediaUrl: (key: string | null) => (key ? `https://media.example.com/${key}` : null)
}));

vi.mock("../queue", () => ({
  enqueueMediaProcessing: mocks.enqueueMediaProcessing
}));

const quarantinedRow = {
  id: MEDIA_ID,
  owner_id: OWNER_ID,
  byte_size: "1024",
  mime_type: "image/jpeg",
  quarantine_object_key: `quarantine/${OWNER_ID}/${MEDIA_ID}.jpg`,
  privacy_status: "quarantined"
};

const completeBody = {
  privacyRegions: [],
  containsPeopleOrPlates: false,
  rightsConfirmed: true
};

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ code: error.code, detail: error.message });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ code: "VALIDATION_FAILED" });
    }
    return reply.code(500).send({ code: "INTERNAL_ERROR" });
  });
  await app.register(mediaRoutes);
  return app;
}

function clientQueriesMatching(fragment: string) {
  return mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  // The mocked transaction runs its callback against the same fake client, so
  // assertions on clientQuery prove what committed inside the transaction.
  mocks.transaction.mockImplementation(async (callback: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) =>
    callback({ query: mocks.clientQuery })
  );
  mocks.getQuarantineMetadata.mockResolvedValue({ ContentLength: 1024, ContentType: "image/jpeg" });
  mocks.enqueueMediaProcessing.mockResolvedValue(undefined);
});

describe("POST /media/uploads/:id/complete", () => {
  it("claims the transition, audits, and enqueues exactly once inside one boundary", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [quarantinedRow], rowCount: 1 });
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/media/uploads/${MEDIA_ID}/complete`,
      payload: completeBody
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "processing" });

    // The state transition is gated on the quarantined status.
    const transitions = clientQueriesMatching("SET privacy_status = 'processing'");
    expect(transitions).toHaveLength(1);
    expect(String(transitions[0]![0])).toContain("privacy_status = 'quarantined'");

    // The audit row is written by the same transaction client as the transition.
    expect(clientQueriesMatching("INSERT INTO audit_logs")).toHaveLength(1);

    // Deterministic job id, enqueued exactly once.
    expect(mocks.enqueueMediaProcessing).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMediaProcessing).toHaveBeenCalledWith(MEDIA_ID, `media-${MEDIA_ID}`);
  });

  it("rejects a duplicate completion that loses the atomic claim, without auditing or enqueueing again", async () => {
    // A concurrent request passed the fast-path SELECT while it was still
    // quarantined, but the conditional UPDATE finds the row already claimed.
    mocks.query.mockResolvedValueOnce({ rows: [quarantinedRow], rowCount: 1 });
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/media/uploads/${MEDIA_ID}/complete`,
      payload: completeBody
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CONFLICT");
    expect(clientQueriesMatching("INSERT INTO audit_logs")).toHaveLength(0);
    expect(mocks.enqueueMediaProcessing).not.toHaveBeenCalled();
  });

  it("compensates with a guarded update when the queue is unavailable", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [quarantinedRow], rowCount: 1 });
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.enqueueMediaProcessing.mockRejectedValueOnce(new Error("redis down"));
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/media/uploads/${MEDIA_ID}/complete`,
      payload: completeBody
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("QUEUE_UNAVAILABLE");
    const compensation = mocks.query.mock.calls.find(([sql]) => String(sql).includes("QUEUE_UNAVAILABLE"));
    expect(compensation).toBeDefined();
    // The compensation must not clobber a state the worker has already advanced.
    expect(String(compensation![0])).toContain("privacy_status = 'processing'");
  });
});

describe("POST /media/:id/retry", () => {
  it("rejects a concurrent retry that loses the atomic claim, without enqueueing again", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ owner_id: OWNER_ID, privacy_status: "failed" }], rowCount: 1 });
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: `/media/${MEDIA_ID}/retry` });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CONFLICT");
    expect(mocks.enqueueMediaProcessing).not.toHaveBeenCalled();
  });

  it("claims a failed upload and enqueues exactly one new job", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ owner_id: OWNER_ID, privacy_status: "failed" }], rowCount: 1 });
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: `/media/${MEDIA_ID}/retry` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "processing" });
    expect(mocks.enqueueMediaProcessing).toHaveBeenCalledTimes(1);
    const claim = mocks.query.mock.calls.find(([sql]) => String(sql).includes("SET privacy_status = 'processing'"));
    expect(String(claim![0])).toContain("privacy_status IN ('failed', 'rejected')");
  });
});
