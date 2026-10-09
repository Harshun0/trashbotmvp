import Link from "next/link";
import { requireSession, isAdmin } from "@/lib/dashboard-session";
import { getOrgId, getListings, getRequirements, getMatches } from "@/lib/dashboard-data";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function DashboardHome() {
  const session = await requireSession();
  const orgId = await getOrgId();
  if (!orgId) {
    return <p className="text-muted-foreground">No organization configured yet.</p>;
  }

  if (isAdmin(session)) {
    const [sellerCount, buyerCount, openRequirements, pendingQuotes, submittedQuotes] = await Promise.all([
      prisma.party.count({ where: { organizationId: orgId, role: { in: ["SELLER", "BOTH"] } } }),
      prisma.party.count({ where: { organizationId: orgId, role: { in: ["BUYER", "BOTH"] } } }),
      prisma.requirement.count({ where: { organizationId: orgId, status: "OPEN" } }),
      prisma.quote.count({ where: { organizationId: orgId, status: "PENDING" } }),
      prisma.quote.count({ where: { organizationId: orgId, status: "SUBMITTED" } }),
    ]);

    const stats = [
      { label: "Sellers", value: sellerCount, href: "/dashboard/sellers" },
      { label: "Buyers", value: buyerCount, href: "/dashboard/buyers" },
      { label: "Open requirements", value: openRequirements, href: "/dashboard/requirements" },
      { label: "Quotes pending", value: pendingQuotes, href: "/dashboard/quotes" },
      { label: "Quotes submitted", value: submittedQuotes, href: "/dashboard/quotes" },
    ];

    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="transition hover:shadow-md">
              <CardHeader>
                <CardTitle className="text-sm font-normal text-muted-foreground">{s.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{s.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    );
  }

  if (!session.partyId) {
    return <p className="text-muted-foreground">Unknown session role.</p>;
  }

  const showSeller = session.role === "SELLER" || session.role === "BOTH";
  const showBuyer = session.role === "BUYER" || session.role === "BOTH";

  const [listings, sellerMatches, requirements, buyerMatches] = await Promise.all([
    showSeller ? getListings(orgId, session.partyId) : Promise.resolve([]),
    showSeller ? getMatches(orgId, { sellerPartyId: session.partyId }) : Promise.resolve([]),
    showBuyer ? getRequirements(orgId, session.partyId) : Promise.resolve([]),
    showBuyer ? getMatches(orgId, { buyerPartyId: session.partyId }) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-6">
      {showSeller && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Aapki listings</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listings.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="font-mono">{l.code}</TableCell>
                      <TableCell>{l.product}</TableCell>
                      <TableCell>{l.quantity ? `${l.quantity} ${l.unit ?? ""}` : "—"}</TableCell>
                      <TableCell>{l.pricePerUnit ? `₹${l.pricePerUnit}` : "—"}</TableCell>
                      <TableCell><Badge variant="outline">{l.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {listings.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Koi listing nahi hai abhi.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Seller matches ({sellerMatches.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Your listing</TableHead>
                    <TableHead>Buyer wants</TableHead>
                    <TableHead>Buyer interested?</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sellerMatches.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{m.listing.code} — {m.listing.product}</TableCell>
                      <TableCell>{m.requirement.product} ({m.requirement.buyerParty.name ?? "buyer"})</TableCell>
                      <TableCell>{m.buyerInterestedAt ? <Badge>Yes</Badge> : <Badge variant="outline">Not yet</Badge>}</TableCell>
                    </TableRow>
                  ))}
                  {sellerMatches.length === 0 && (
                    <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">Abhi koi match nahi mila.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {showBuyer && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Aapki requests</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>Max price</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requirements.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.product}</TableCell>
                      <TableCell>{r.quantity ? `${r.quantity} ${r.unit ?? ""}` : "—"}</TableCell>
                      <TableCell>{r.maxPrice ? `₹${r.maxPrice}` : "—"}</TableCell>
                      <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {requirements.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Koi request nahi hai abhi.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Buyer matches ({buyerMatches.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Your request</TableHead>
                    <TableHead>Matching listing</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buyerMatches.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{m.requirement.product}</TableCell>
                      <TableCell>{m.listing.code} — {m.listing.product} ({m.listing.sellerParty.name ?? "seller"})</TableCell>
                    </TableRow>
                  ))}
                  {buyerMatches.length === 0 && (
                    <TableRow><TableCell colSpan={2} className="text-center text-muted-foreground">Abhi koi match nahi mila.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
