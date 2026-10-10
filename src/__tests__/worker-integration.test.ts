/**
 * Integration-style tests for processInboundMessage and processStatusUpdate.
 *
 * These call the real worker functions (not handleOnboarding directly), so they
 * exercise the full path: contact upsert → conversation upsert → message save
 * → bot dispatch. Prisma and sendQueue are mocked.
 *
 * Tests:
 *  1. New contact text → Party created + ASK_ROLE reply enqueued
 *  2. Button tap role_buyer on existing party(ASK_ROLE) → role=BUYER, step=ASK_NAME, name question queued
 *     (this is the exact bug that was broken — must fail on old code)
 *  3. Duplicate inbound (P2002 on message.create) → bot STILL runs, same jobId
 *  4. processStatusUpdate attempt < 3 → throws (BullMQ retries)
 *  5. processStatusUpdate attempt >= 3 → does NOT throw (gives up gracefully)
 *  6. processStatusUpdate message found → updates status correctly
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InternalInboundMessage, InternalStatusUpdate } from "@/providers/types";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findFirst: vi.fn() },
    contact: { upsert: vi.fn() },
    conversation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    message: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    party: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    webhookEvent: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    listing: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    requirement: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    quote: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/bot/extractor", () => ({ extractIntent: vi.fn() }));
vi.mock("@/bot/rate-limit", () => ({ allowLLMCall: vi.fn().mockResolvedValue(true) }));

vi.mock("@/queues", () => ({
  sendQueue: { add: vi.fn() },
  webhookQueue: { add: vi.fn() },
  sweeperQueue: { add: vi.fn(), upsertJobScheduler: vi.fn() },
}));

vi.mock("@/lib/redis", () => ({
  redis: { on: vi.fn(), quit: vi.fn() },
}));

vi.mock("@/providers", () => ({
  getProvider: vi.fn(),
  resetProvider: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import { processInboundMessage, processStatusUpdate, runSweep } from "@/queues/worker";
import { webhookQueue } from "@/queues";
import { BTN } from "@/bot/onboarding";
import { extractIntent } from "@/bot/extractor";

// ─── Typed mock accessors ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type M = ReturnType<typeof vi.fn<any>>;

const org  = prisma.organization as unknown as { findFirst: M };
const cont = prisma.contact      as unknown as { upsert: M };
const conv = prisma.conversation as unknown as { findUnique: M; create: M; update: M; findUniqueOrThrow: M };
const msg  = prisma.message      as unknown as { create: M; findUnique: M; update: M; findMany: M };
const pty  = prisma.party        as unknown as { findUnique: M; create: M; update: M };
const list = prisma.listing      as unknown as { findFirst: M; findUnique: M; count: M; create: M; update: M };
const we   = prisma.webhookEvent as unknown as { findUnique: M; update: M; findMany: M; updateMany: M };
const qadd = sendQueue.add       as M;
const wqadd = webhookQueue.add   as M;
const mockedExtractIntent = extractIntent as unknown as M;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = "org_main";
const FROM   = "+919900000001";
const WAMID  = "wamid_live_001";
const BTN_WAMID = "wamid_btn_001";

const CONTACT_ROW = { id: "contact_1", waPhone: FROM, organizationId: ORG_ID };
const CONV_ROW    = { id: "conv_1", contactId: "contact_1", organizationId: ORG_ID, lastInboundAt: new Date() };
const MSG_ROW     = { id: "msg_1", providerId: WAMID };
const PARTY_NEW   = { id: "party_1", contactId: "contact_1", organizationId: ORG_ID, onboardingStep: "ASK_ROLE", role: null };
const PARTY_DONE  = { id: "party_1", contactId: "contact_1", organizationId: ORG_ID, onboardingStep: "ASK_NAME", role: "BUYER" };

function textMsg(msgId = WAMID): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: FROM,
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "text",
    content: { body: "Hii" },
  };
}

/** Exact payload shape stored in DB from a real Meta button tap */
function buyerBtnMsg(msgId = BTN_WAMID): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: FROM,
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "interactive",
    // This is the EXACT content shape stored in messages table
    content: { type: "button_reply", button_reply: { id: BTN.ROLE_BUYER, title: "Buyer 🛍️" } },
  };
}

function statusMsg(providerId = WAMID, status: InternalStatusUpdate["status"] = "delivered"): InternalStatusUpdate {
  return {
    kind: "status",
    providerEventId: `status_${providerId}_${status}`,
    providerId,
    status,
    timestamp: new Date(),
    recipientPhone: FROM,
  };
}

function setupHappyPath() {
  org.findFirst.mockResolvedValue({ id: ORG_ID });
  cont.upsert.mockResolvedValue(CONTACT_ROW);
  conv.findUnique.mockResolvedValue(null);
  conv.create.mockResolvedValue(CONV_ROW);
  conv.update.mockResolvedValue({ ...CONV_ROW, lastInboundAt: new Date() });
  conv.findUniqueOrThrow.mockResolvedValue({ ...CONV_ROW, lastInboundAt: new Date() });
  msg.findUnique.mockResolvedValue(null);
  msg.update.mockResolvedValue({});
  msg.findMany.mockResolvedValue([]);
  qadd.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPath();
  // Default: two message.create calls — inbound save + bot reply save
  msg.create
    .mockResolvedValueOnce(MSG_ROW)
    .mockResolvedValue({ id: "msg_reply_1" });
});

// ─── 1. New contact text → Party created + ASK_ROLE enqueued ─────────────────

describe("processInboundMessage — new contact text", () => {
  it("creates Party as BUYER and enqueues ASK_NAME reply (buyer-only pivot, no role question)", async () => {
    pty.findUnique.mockResolvedValue(null);
    pty.create.mockResolvedValue({ ...PARTY_NEW, role: "BUYER", onboardingStep: "ASK_NAME" });
    pty.update.mockResolvedValue({ ...PARTY_NEW, onboardingStep: "ASK_NAME" });

    await processInboundMessage(textMsg(), ORG_ID);

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "ASK_NAME", role: "BUYER" }),
      })
    );
    expect(qadd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining(`onboard_name_${WAMID}`) })
    );
  });

  it("uses contact.upsert (not create) — no P2002 possible", async () => {
    pty.findUnique.mockResolvedValue(null);
    pty.create.mockResolvedValue(PARTY_NEW);

    await processInboundMessage(textMsg(), ORG_ID);

    expect(cont.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId_waPhone: expect.anything() }),
      })
    );
  });
});

// ─── 2. Button tap role_buyer on existing party ───────────────────────────────
// THIS IS THE PRIMARY BUG TEST — must fail on old code, pass on new code

describe("processInboundMessage — button tap role_buyer (the live bug)", () => {
  beforeEach(() => {
    // Party exists with step ASK_ROLE (user already got the role question)
    pty.findUnique.mockResolvedValue(PARTY_NEW);
    pty.update.mockResolvedValue(PARTY_DONE);
    msg.create
      .mockResolvedValueOnce({ id: "msg_btn_inbound", providerId: BTN_WAMID })
      .mockResolvedValue({ id: "msg_reply_name" });
  });

  it("sets role=BUYER and step=ASK_NAME", async () => {
    await processInboundMessage(buyerBtnMsg(), ORG_ID);

    expect(pty.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "BUYER", onboardingStep: "ASK_NAME" }),
      })
    );
  });

  it("enqueues the name question as OUTBOUND", async () => {
    await processInboundMessage(buyerBtnMsg(), ORG_ID);

    expect(qadd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ contentType: "text" }),
      expect.objectContaining({ jobId: expect.stringContaining(`onboard_name_${BTN_WAMID}`) })
    );
  });

  it("uses exact BTN.ROLE_BUYER constant for matching", () => {
    // Ensure the constant hasn't drifted from what Meta sends
    expect(BTN.ROLE_BUYER).toBe("role_buyer");
    expect(BTN.ROLE_SELLER).toBe("role_seller");
  });
});

// ─── 3. Duplicate inbound (P2002 on message.create) ──────────────────────────

describe("processInboundMessage — duplicate inbound", () => {
  it("bot runs even when message P2002 fires", async () => {
    pty.findUnique.mockResolvedValue(PARTY_NEW);
    pty.update.mockResolvedValue(PARTY_DONE);

    const p2002 = Object.assign(new Error("unique"), { code: "P2002" });
    msg.create
      .mockRejectedValueOnce(p2002)  // inbound message already exists
      .mockResolvedValue({ id: "msg_reply_1" }); // bot reply saves fine

    await processInboundMessage(textMsg(WAMID), ORG_ID);

    // Bot ran — a reply was queued despite P2002
    expect(qadd).toHaveBeenCalled();
  });
});

// ─── 4 & 5. processStatusUpdate — attempt cap ────────────────────────────────

describe("processStatusUpdate — unknown message attempt cap", () => {
  beforeEach(() => {
    msg.findUnique.mockResolvedValue(null);
  });

  it("throws at attempt 0 (retry)", async () => {
    await expect(processStatusUpdate(statusMsg(), 0)).rejects.toThrow();
  });

  it("throws at attempt 2 (retry)", async () => {
    await expect(processStatusUpdate(statusMsg(), 2)).rejects.toThrow();
  });

  it("does NOT throw at attempt 3 (give up)", async () => {
    await expect(processStatusUpdate(statusMsg(), 3)).resolves.toBeUndefined();
  });

  it("does NOT throw at attempt 5 (give up)", async () => {
    await expect(processStatusUpdate(statusMsg(), 5)).resolves.toBeUndefined();
  });
});

// ─── 6. processStatusUpdate — message found ──────────────────────────────────

describe("processStatusUpdate — message found", () => {
  const DB_MSG = { id: "db_msg_1", providerId: WAMID };

  beforeEach(() => {
    msg.findUnique.mockResolvedValue(DB_MSG);
  });

  it("updates status DELIVERED", async () => {
    await processStatusUpdate(statusMsg(WAMID, "delivered"), 0);
    expect(msg.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DELIVERED" }) })
    );
  });

  it("updates status READ", async () => {
    await processStatusUpdate(statusMsg(WAMID, "read"), 0);
    expect(msg.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "READ" }) })
    );
  });

  it("updates FAILED with errorTitle as failureReason", async () => {
    const s: InternalStatusUpdate = {
      ...statusMsg(WAMID, "failed"),
      errorCode: "131047",
      errorTitle: "Re-engagement required",
    };
    await processStatusUpdate(s, 0);
    expect(msg.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", failureReason: "Re-engagement required" }),
      })
    );
  });
});

// ─── 7. Phase 2 — real Meta inbound payload through processInboundMessage ────
// A registered SELLER sends a product message in the exact content shape Meta
// delivers (msg.text.body), end to end: contact/conversation upsert → message
// save → handleOnboarding → routeRegisteredUser → draft Listing created.

describe("processInboundMessage — Phase 2 seller listing (real Meta payload shape)", () => {
  const SELLER_PARTY = {
    id: "party_seller_1",
    contactId: "contact_1",
    organizationId: ORG_ID,
    onboardingStep: "DONE",
    role: "SELLER",
  };

  function metaTextMsg(body: string, msgId = "wamid_listing_001"): InternalInboundMessage {
    return {
      kind: "message",
      providerEventId: `msg_${msgId}`,
      providerId: msgId,
      fromPhone: FROM,
      toPhone: "+919900000000",
      timestamp: new Date(),
      contentType: "text",
      // Exact shape MetaCloudProvider.parseWebhook extracts for msg.type === "text"
      content: { body },
    };
  }

  it("'100 ton cement bags sell karna hai' → creates DRAFT listing and asks for quantity", async () => {
    msg.create.mockReset();
    msg.create.mockResolvedValue({ id: "msg_reply_1" });
    pty.findUnique.mockResolvedValue(SELLER_PARTY);
    list.findFirst.mockResolvedValue(null); // no existing draft/open listing
    list.count.mockResolvedValue(0);
    list.findUnique.mockResolvedValue(null); // LST-0001 is free
    list.create.mockResolvedValue({
      id: "listing_1",
      code: "LST-0001",
      product: "cement",
      quantity: 100,
      unit: null,
      pricePerUnit: null,
      location: null,
      status: "DRAFT",
    });
    mockedExtractIntent.mockResolvedValue({
      intent: "create_listing",
      product: "cement",
      category: null,
      quantity: 100,
      unit: null,
      price: null,
      location: null,
      listingCode: null,
      missing: ["unit", "price", "location"],
    });

    await processInboundMessage(metaTextMsg("100 ton cement bags sell karna hai"), ORG_ID);

    expect(list.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          sellerPartyId: "party_seller_1",
          code: "LST-0001",
          product: "cement",
        }),
      })
    );
    expect(qadd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("quantity") }) }),
      expect.anything()
    );
  });
});

// ─── 8. Sweeper — stuck webhook_events ────────────────────────────────────────

describe("runSweep", () => {
  it("re-enqueues a recently-stuck event with a fresh, non-colliding jobId", async () => {
    const recent = { id: "evt_recent", createdAt: new Date(Date.now() - 5 * 60 * 1000), rawPayload: {}, provider: "meta" };
    we.findMany.mockResolvedValue([recent]);
    wqadd.mockResolvedValue(undefined);

    await runSweep();

    expect(wqadd).toHaveBeenCalledWith(
      "process-webhook",
      expect.objectContaining({ webhookEventId: "evt_recent" }),
      expect.objectContaining({ jobId: expect.stringMatching(/^webhook_evt_recent_sweep_\d+$/) })
    );
    expect(we.updateMany).not.toHaveBeenCalled();
  });

  it("permanently gives up on an event stuck for over an hour — marks processed, never re-enqueues it", async () => {
    const ancient = { id: "evt_ancient", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), rawPayload: {}, provider: "meta" };
    we.findMany.mockResolvedValue([ancient]);
    we.updateMany.mockResolvedValue({ count: 1 });

    await runSweep();

    expect(we.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["evt_ancient"] } },
        data: expect.objectContaining({ processed: true }),
      })
    );
    expect(wqadd).not.toHaveBeenCalled();
  });

  it("handles a mix of recent and ancient stuck events correctly", async () => {
    const recent = { id: "evt_recent2", createdAt: new Date(Date.now() - 5 * 60 * 1000), rawPayload: {}, provider: "meta" };
    const ancient = { id: "evt_ancient2", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), rawPayload: {}, provider: "meta" };
    we.findMany.mockResolvedValue([ancient, recent]);
    we.updateMany.mockResolvedValue({ count: 1 });
    wqadd.mockResolvedValue(undefined);

    await runSweep();

    expect(we.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["evt_ancient2"] } } })
    );
    expect(wqadd).toHaveBeenCalledWith(
      "process-webhook",
      expect.objectContaining({ webhookEventId: "evt_recent2" }),
      expect.anything()
    );
  });

  it("no stuck events → no-op", async () => {
    we.findMany.mockResolvedValue([]);

    await expect(runSweep()).resolves.toBeUndefined();

    expect(we.updateMany).not.toHaveBeenCalled();
    expect(wqadd).not.toHaveBeenCalled();
  });
});
