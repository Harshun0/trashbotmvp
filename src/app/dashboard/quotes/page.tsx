import { requireAdmin } from "@/lib/dashboard-session";
import { getOrgId, getQuotes } from "@/lib/dashboard-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function QuotesPage() {
  await requireAdmin();
  const orgId = await getOrgId();
  const quotes = orgId ? await getQuotes(orgId) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seller quotes ({quotes.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Requirement</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Deliver by</TableHead>
              <TableHead>Quality</TableHead>
              <TableHead>Photos</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quotes.map((q) => (
              <TableRow key={q.id}>
                <TableCell>{q.requirement.product} ({q.requirement.location ?? "—"})</TableCell>
                <TableCell>{q.requirement.buyerParty.name ?? "—"}</TableCell>
                <TableCell>{q.sellerParty.name ?? q.sellerParty.contact.waPhone} ({q.sellerParty.city ?? "—"})</TableCell>
                <TableCell>{q.price != null ? `₹${q.price}` : "—"}</TableCell>
                <TableCell>{q.deliverByDays != null ? `${q.deliverByDays} din` : "—"}</TableCell>
                <TableCell>{q.quality ?? "—"}</TableCell>
                <TableCell>{q.media.length}</TableCell>
                <TableCell><Badge variant={q.status === "SUBMITTED" ? "default" : "outline"}>{q.status}</Badge></TableCell>
              </TableRow>
            ))}
            {quotes.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Koi quote nahi hai abhi.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
