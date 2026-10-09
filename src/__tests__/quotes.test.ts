/**
 * Seller quote collection tests (the buyer-only pivot).
 *
 * Covers:
 *  1. broadcastRequirementToSellers — finds matching-city sellers, creates
 *     PENDING quotes, sends in-window interactive messages, sets broadcastAt
 *  2. broadcastRequirementToSellers — outside window falls back to template
 *     (or skips cleanly when no template is configured)
 *  3. getPendingQuote
 *  4. handleSellerQuoteReply — progressive collection: price → deliverByDays →
 *     quality → SUBMITTED
 *  5. handleSellerQuoteReply — image → QuoteMedia saved
 *  6. handleSellerQuoteReply — extractor failure → fixed rephrase, never throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    party: { findMany: vi.fn() },
    quote: { upsert: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    quoteMedia: { count: vi.fn(), create: vi.fn() },
    requirement: { update: vi.fn() },
    conversation: { findUnique: vi.fn() },
    message: { create: vi.fn() },
  },
}));

vi.mock("@/queues", () => ({
  sendQueue: { add: vi.fn() },
  webhookQueue: { add: vi.fn() },
  sweeperQueue: { add: vi.fn(), upsertJobScheduler: vi.fn() },
}));

vi.mock("@/bot/extractor", () => ({ extractQuoteDetails: vi.fn() }));
vi.mock("@/bot/rate-limit", () => ({
  allowAlert: vi.fn().mockResolvedValue(true),
  allowLLMCall: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/providers", () => ({ getProvider: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import {
  broadcastRequirementToSellers,
  getPendingQuote,
  handleSellerQuoteReply,
} from "@/bot/quotes";
import { extractQuoteDetails } from "@/bot/extractor";
import { allowAlert } from "@/bot/rate-limit";
import { getProvider } from "@/providers";
import { getStorage } from "@/lib/storage";
import type { InternalInboundMessage } from "@/providers/types";
import type { Party, Requirement, Quote } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<any>>;

const party = prisma.party as unknown as { findMany: MockFn };
const quote = prisma.quote as unknown as { upsert: MockFn; findFirst: MockFn; update: MockFn };
const quoteMedia = prisma.quoteMedia as unknown as { count: MockFn; create: MockFn };
const requirement = prisma.requirement as unknown as { update: MockFn };
const conversation = prisma.conversation as unknown as { findUnique: MockFn };
const message = prisma.message as unknown as { create: MockFn };
const queueAdd = sendQueue.add as MockFn;
const mockedExtractQuoteDetails = extractQuoteDetails as unknown as MockFn;
const mockedAllowAlert = allowAlert as unknown as MockFn;
const mockedGetProvider = getProvider as unknown as MockFn;
const mockedGetStorage = getStorage as unknown as MockFn;

const ORG = "org_main";

function baseRequirement(overrides: Record<string, unknown> = {}): Requirement {
  return {
    id: "req_1",
    organizationId: ORG,
    buyerPartyId: "buyer_1",
    product: "cement",
    category: null,
    quantity: 50,
    unit: "ton",
    maxPrice: 40,
    location: "Pune",
    deadlineDays: 3,
    broadcastAt: null,
    status: "OPEN",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Requirement;
}

function sellerParty(overrides: Partial<Party> = {}): Party {
  return {
    id: "seller_1",
    organizationId: ORG,
    contactId: "seller_contact_1",
    role: "SELLER",
    name: "Suresh",
    city: "Pune",
    company: null,
    onboardingStep: "DONE",
    alertPreference: "ALL",
    alertsOptedInAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Party;
}

function baseQuote(overrides: Record<string, unknown> = {}): Quote & { requirement: Requirement } {
  return {
    id: "quote_1",
    organizationId: ORG,
    requirementId: "req_1",
    sellerPartyId: "seller_1",
    price: null,
    deliverByDays: null,
    quality: null,
    status: "PENDING",
    createdAt: new Date(),
    updatedAt: new Date(),
    requirement: baseRequirement(),
    ...overrides,
  } as unknown as Quote & { requirement: Requirement };
}

function textMsg(text: string, msgId = "wamid_1"): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: "+919900000099",
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "text",
    content: { body: text },
  };
}

function imageMsg(mediaId = "wamedia_1", msgId = "wamid_img"): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: "+919900000099",
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "image",
    content: { id: mediaId, mime_type: "image/jpeg" },
  };
}

function ctx(parsed: InternalInboundMessage) {
  return {
    orgId: ORG,
    contact: { id: "seller_contact_1", waPhone: "+919900000099" },
    conversation: { id: "conv_1", lastInboundAt: new Date() },
    parsed,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAllowAlert.mockResolvedValue(true);
  message.create.mockResolvedValue({ id: "msg_out_1" });
  queueAdd.mockResolvedValue(undefined);
});

// ─── 1. Broadcast ─────────────────────────────────────────────────────────────

describe("broadcastRequirementToSellers", () => {
  it("finds sellers in the matching city, creates PENDING quotes, sends in-window message, sets broadcastAt", async () => {
    party.findMany.mockResolvedValue([sellerParty()]);
    quote.upsert.mockResolvedValue({ id: "quote_1" });
    conversation.findUnique.mockResolvedValue({
      id: "conv_seller_1",
      lastInboundAt: new Date(),
      contact: { waPhone: "+919900000099" },
    });

    const sent = await broadcastRequirementToSellers(ORG, baseRequirement());

    expect(sent).toBe(1);
    expect(quote.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requirementId_sellerPartyId: { requirementId: "req_1", sellerPartyId: "seller_1" } },
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("cement") }) }),
      expect.anything()
    );
    expect(requirement.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req_1" }, data: { broadcastAt: expect.any(Date) } })
    );
  });

  it("is a no-op if already broadcast", async () => {
    const sent = await broadcastRequirementToSellers(ORG, baseRequirement({ broadcastAt: new Date() }));

    expect(sent).toBe(0);
    expect(party.findMany).not.toHaveBeenCalled();
  });

  it("filters out sellers in a different city", async () => {
    party.findMany.mockResolvedValue([sellerParty({ id: "seller_mumbai", city: "Mumbai" })]);

    const sent = await broadcastRequirementToSellers(ORG, baseRequirement({ location: "Pune" }));

    expect(sent).toBe(0);
    expect(quote.upsert).not.toHaveBeenCalled();
  });

  it("outside the 24h window with no template configured → skips that seller, no crash", async () => {
    party.findMany.mockResolvedValue([sellerParty()]);
    quote.upsert.mockResolvedValue({ id: "quote_1" });
    conversation.findUnique.mockResolvedValue({
      id: "conv_seller_1",
      lastInboundAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      contact: { waPhone: "+919900000099" },
    });

    const sent = await broadcastRequirementToSellers(ORG, baseRequirement());

    expect(sent).toBe(0);
    expect(queueAdd).not.toHaveBeenCalled();
    expect(requirement.update).toHaveBeenCalled(); // broadcastAt still set — don't retry forever
  });

  it("respects the per-seller alert cap", async () => {
    party.findMany.mockResolvedValue([sellerParty()]);
    mockedAllowAlert.mockResolvedValue(false);

    const sent = await broadcastRequirementToSellers(ORG, baseRequirement());

    expect(sent).toBe(0);
    expect(queueAdd).not.toHaveBeenCalled(); // capped — quote row still created, but no message sent
  });
});

// ─── 3. getPendingQuote ────────────────────────────────────────────────────────

describe("getPendingQuote", () => {
  it("queries for the most recent PENDING quote", async () => {
    const pending = baseQuote();
    quote.findFirst.mockResolvedValue(pending);

    const result = await getPendingQuote(ORG, "seller_1");

    expect(quote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, sellerPartyId: "seller_1", status: "PENDING" } })
    );
    expect(result).toBe(pending);
  });
});

// ─── 4. Progressive quote collection ───────────────────────────────────────────

describe("handleSellerQuoteReply — progressive collection", () => {
  it("first reply with price only → asks deliverByDays", async () => {
    const q = baseQuote();
    mockedExtractQuoteDetails.mockResolvedValue({ price: 35, deliverByDays: null, quality: null });
    quote.update.mockResolvedValue({ ...q, price: 35 });

    await handleSellerQuoteReply(ctx(textMsg("35 per ton")), sellerParty(), q);

    expect(quote.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "quote_1" }, data: expect.objectContaining({ price: 35 }) })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("din") }) }),
      expect.anything()
    );
  });

  it("deliverByDays added → asks quality", async () => {
    const q = baseQuote({ price: 35 });
    mockedExtractQuoteDetails.mockResolvedValue({ price: null, deliverByDays: 2, quality: null });
    quote.update.mockResolvedValue({ ...q, deliverByDays: 2 });

    await handleSellerQuoteReply(ctx(textMsg("2 din mein de dunga")), sellerParty(), q);

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Quality") }) }),
      expect.anything()
    );
  });

  it("quality added (all fields present) → marks SUBMITTED", async () => {
    const q = baseQuote({ price: 35, deliverByDays: 2 });
    mockedExtractQuoteDetails.mockResolvedValue({ price: null, deliverByDays: null, quality: "A grade" });
    quote.update.mockResolvedValue({ ...q, quality: "A grade" });

    await handleSellerQuoteReply(ctx(textMsg("A grade hai")), sellerParty(), q);

    expect(quote.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "quote_1" }, data: { status: "SUBMITTED" } })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Dhanyawad") }) }),
      expect.anything()
    );
  });

  it("extractor returns null → fixed rephrase reply, never throws", async () => {
    const q = baseQuote();
    mockedExtractQuoteDetails.mockResolvedValue(null);

    await expect(handleSellerQuoteReply(ctx(textMsg("asdkj")), sellerParty(), q)).resolves.toBeUndefined();

    expect(quote.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Samajh nahi paya") }) }),
      expect.anything()
    );
  });
});

// ─── 5. Photo handling ──────────────────────────────────────────────────────────

describe("handleSellerQuoteReply — photo", () => {
  it("downloads media, uploads to storage, saves QuoteMedia", async () => {
    const q = baseQuote({ price: 35, deliverByDays: 2, quality: "A grade" });
    quoteMedia.count.mockResolvedValue(0);
    quoteMedia.create.mockResolvedValue({ id: "media_1" });
    const buffer = Buffer.from("fake-bytes");
    mockedGetProvider.mockReturnValue({ downloadMedia: vi.fn().mockResolvedValue({ buffer, mimeType: "image/jpeg" }) });
    const uploadMock = vi.fn().mockResolvedValue({ url: "https://cdn.example.com/img.jpg" });
    mockedGetStorage.mockReturnValue({ upload: uploadMock });

    await handleSellerQuoteReply(ctx(imageMsg("wamedia_1")), sellerParty(), q);

    expect(uploadMock).toHaveBeenCalledWith(buffer, "image/jpeg");
    expect(quoteMedia.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quoteId: "quote_1", whatsappMediaId: "wamedia_1", storageUrl: "https://cdn.example.com/img.jpg" }),
      })
    );
  });

  it("max photos reached → declines, no crash", async () => {
    const q = baseQuote();
    quoteMedia.count.mockResolvedValue(3);

    await handleSellerQuoteReply(ctx(imageMsg("wamedia_2")), sellerParty(), q);

    expect(quoteMedia.create).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("already") }) }),
      expect.anything()
    );
  });
});
