import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { badRequest, conflict, notFound, readJson, withAuthMutation } from "@/lib/api";
import { generateRecipients } from "@/lib/campaign-recipients";
import { getSmtpConfig } from "@/lib/settings";

type Ctx = { params: Promise<{ id: string }> };

type Body = { scheduledAt?: string };

/** Accept only an explicit UTC instant, never a timezone-less server-local date. */
function parseFutureScheduledAt(value: unknown): Date {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    badRequest("Scheduled time must be a UTC ISO timestamp");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) badRequest("Scheduled time is invalid");
  if (date.getTime() <= Date.now()) badRequest("Scheduled time must be in the future");
  return date;
}

/**
 * Materializes the queue and hands the campaign to the worker.
 *
 * Two things make this safe against a double-clicked button or a retried HTTP
 * request: the DRAFT -> QUEUED transition is a conditional UPDATE (only one
 * caller can win), and recipient rows are inserted with ON CONFLICT DO NOTHING
 * against UNIQUE(campaign_id, email_normalized).
 *
 * Nothing is sent here — this endpoint only enqueues.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const body = await readJson<Body>(request);
    const scheduledAt = body.scheduledAt === undefined ? null : parseFutureScheduledAt(body.scheduledAt);
    const targetStatus = scheduledAt ? "SCHEDULED" : "QUEUED";

    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    const campaign = rows[0];
    if (!campaign) notFound("Campaign not found");
    if (campaign.status !== "DRAFT") conflict(`This campaign is already ${campaign.status}`);
    if (!campaign.subject.trim()) badRequest("Give the campaign a subject first");
    if (!campaign.compiledHtml.trim()) badRequest("The email body is empty");

    const config = await getSmtpConfig();
    if (!config) badRequest("Configure SMTP in Settings before sending");

    // Claim the campaign first: a second concurrent request finds it non-DRAFT.
    // For a scheduled send this also prevents concurrent worker ticks from
    // seeing a partially prepared campaign: the timestamp must be due before
    // it can become QUEUED.
    const claimed = await db
      .update(campaigns)
      .set({ status: targetStatus, scheduledAt, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, "DRAFT")))
      .returning({ id: campaigns.id });

    if (claimed.length === 0) conflict("This campaign was already queued by another request");

    let result;
    try {
      result = await generateRecipients(id);
    } catch (error) {
      // Do not leave a failed queue-materialization in a state the worker may
      // later process. The conditional status check keeps a concurrent action
      // from being overwritten.
      await db
        .update(campaigns)
        .set({ status: "DRAFT", scheduledAt: null, updatedAt: new Date() })
        .where(and(eq(campaigns.id, id), eq(campaigns.status, targetStatus)));
      throw error;
    }

    if (result.total === 0) {
      // Nothing to send — roll the campaign back so it stays editable.
      await db
        .update(campaigns)
        .set({ status: "DRAFT", scheduledAt: null, updatedAt: new Date() })
        .where(and(eq(campaigns.id, id), eq(campaigns.status, targetStatus)));
      badRequest("No recipients: the selected lists are empty or fully suppressed");
    }

    return NextResponse.json({ ok: true, status: targetStatus, scheduledAt, ...result });
  });
}
