/**
 * Data access for dashboard pages — thin wrappers around Prisma, scoped by
 * the caller's session (admin sees everything in the org, seller/buyer see
 * only their own rows).
 */
import { prisma } from "./prisma";

export async function getOrgId(): Promise<string | null> {
  const org = await prisma.organization.findFirst({ select: { id: true } });
  return org?.id ?? null;
}

export async function getListings(orgId: string, sellerPartyId?: string) {
  return prisma.listing.findMany({
    where: { organizationId: orgId, ...(sellerPartyId ? { sellerPartyId } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      sellerParty: { select: { name: true, city: true, contact: { select: { waPhone: true } } } },
      media: { select: { id: true, storageUrl: true } },
    },
    take: 200,
  });
}

export async function getRequirements(orgId: string, buyerPartyId?: string) {
  return prisma.requirement.findMany({
    where: { organizationId: orgId, ...(buyerPartyId ? { buyerPartyId } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      buyerParty: { select: { name: true, city: true, contact: { select: { waPhone: true } } } },
    },
    take: 200,
  });
}

export async function getMatches(orgId: string, opts: { sellerPartyId?: string; buyerPartyId?: string } = {}) {
  return prisma.match.findMany({
    where: {
      organizationId: orgId,
      ...(opts.sellerPartyId ? { listing: { sellerPartyId: opts.sellerPartyId } } : {}),
      ...(opts.buyerPartyId ? { requirement: { buyerPartyId: opts.buyerPartyId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      listing: { select: { code: true, product: true, sellerParty: { select: { name: true } } } },
      requirement: { select: { product: true, buyerParty: { select: { name: true } } } },
    },
    take: 200,
  });
}

export async function getParties(orgId: string, role: "SELLER" | "BUYER") {
  // BOTH parties act as both — include them in each list.
  return prisma.party.findMany({
    where: { organizationId: orgId, role: { in: [role, "BOTH"] } },
    orderBy: { createdAt: "desc" },
    include: { contact: { select: { waPhone: true } } },
    take: 200,
  });
}

export async function getPartyById(partyId: string) {
  return prisma.party.findUnique({ where: { id: partyId } });
}

export async function getQuotes(orgId: string, requirementId?: string) {
  return prisma.quote.findMany({
    where: { organizationId: orgId, ...(requirementId ? { requirementId } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      requirement: { select: { product: true, location: true, buyerParty: { select: { name: true } } } },
      sellerParty: { select: { name: true, city: true, contact: { select: { waPhone: true } } } },
      media: { select: { id: true, storageUrl: true } },
    },
    take: 200,
  });
}
