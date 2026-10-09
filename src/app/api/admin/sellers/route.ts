/**
 * POST /api/admin/sellers
 *
 * Admin-only (dashboard session cookie, not INTERNAL_API_KEY — this is
 * called directly from the "Add seller" form on /dashboard/sellers).
 * Creates a Contact + Party in one step, with onboardingStep preset to DONE
 * and role SELLER — the seller never goes through the WhatsApp onboarding
 * flow, they just start receiving broadcast quote requests.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrgId } from "@/lib/dashboard-data";
import { requireAdmin } from "@/lib/dashboard-session";

export const runtime = "nodejs";

const bodySchema = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  waPhone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, "Phone must be in E.164 format, e.g. +919900000000"),
});

export async function POST(request: NextRequest) {
  await requireAdmin(); // redirects to /dashboard/login if not an admin session

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 422 });
  }
  const { name, city, waPhone } = parsed.data;

  const orgId = await getOrgId();
  if (!orgId) {
    return NextResponse.json({ error: "No organization configured" }, { status: 500 });
  }

  const contact = await prisma.contact.upsert({
    where: { organizationId_waPhone: { organizationId: orgId, waPhone } },
    create: {
      organizationId: orgId,
      waPhone,
      optInSource: "AGENT_ADDED",
      optInScope: "service",
    },
    update: {},
  });

  const party = await prisma.party.upsert({
    where: { contactId: contact.id },
    create: {
      organizationId: orgId,
      contactId: contact.id,
      role: "SELLER",
      name,
      city,
      onboardingStep: "DONE",
      alertPreference: "ALL",
      alertsOptedInAt: new Date(),
    },
    update: {
      role: "SELLER",
      name,
      city,
      onboardingStep: "DONE",
      alertPreference: "ALL",
    },
  });

  console.info("[AdminSellers] seller added", { partyId: party.id, city });

  return NextResponse.json({ ok: true, party });
}
