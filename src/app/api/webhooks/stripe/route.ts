import prisma from "@/db/prisma";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const body = await req.text();

  const sig = req.headers.get("stripe-signature")!;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (error: any) {
    console.error("Webhook signature verification failed!!!");
    return new Response(`Webhook Error : ${error.message}`, { status: 400 });
  }

  //handle event
  try {
    switch (event.type) {
      case "checkout.session.completed":
        const session = await stripe.checkout.sessions.retrieve(
          (event.data.object as Stripe.Checkout.Session).id,
          {
            expand: ["line_items"],
          }
        );

        const customerId = session.customer as string;
        const customerDetials = session.customer_details;

        if (customerDetials?.email) {
          const user = await prisma.user.findUnique({
            where: { email: customerDetials.email },
          });
          if (!user) throw new Error("User not found!!!");

          if (!user.customerId) {
            await prisma.user.update({
              where: { id: user.id },
              data: { customerId },
            });
          }
          const lineItems = session.line_items?.data || [];

          for (const item of lineItems) {
            const priceId = item.price?.id;
            const isSubscription = item.price?.type === "recurring";
            if (isSubscription) {
              let endDate = new Date();
              if (priceId === process.env.STRIPE_YEARLY_PRICE_ID!) {
                endDate.setFullYear(endDate.getFullYear() + 1);
              } else if (priceId === process.env.STRIPE_MONTHLY_PRICE_ID!) {
                endDate.setMonth(endDate.getMonth() + 1);
              } else {
                throw new Error("Invalid Price ID!!!");
              }
              //* It's gonna create subscription if it doesn't exist or update if it's already existed!!!
              await prisma.subscription.upsert({
                where: { userId: user.id! },
                create: {
                  userId: user.id,
                  startDate: new Date(),
                  endDate: endDate,
                  plan: "premium",
                  period:
                    priceId === process.env.STRIPE_YEARLY_PRICE_ID!
                      ? "yearly"
                      : "monthly",
                },
                update: {
                  plan: "premium",
                  period:
                    priceId === process.env.STRIPE_YEARLY_PRICE_ID!
                      ? "yearly"
                      : "monthly",
                  startDate: new Date(),
                  endDate: endDate,
                },
              });
              await prisma.user.update({
                where: { id: user.id },
                data: { plan: "premium" },
              });
            } else {
              // One Time
            }
          }
        }
        break;
      case "customer.subscription.deleted":
        const subscription = await stripe.subscriptions.retrieve(
          (event.data.object as Stripe.Subscription).id
        );
        const user = await prisma.user.findUnique({
          where: { customerId: subscription.customer as string },
        });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { plan: "free" },
          });
        } else {
          console.error("User not found for subscription deleted event!!!");
          throw new Error("User not found for subscription deleted event!!!");
        }
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  } catch (error) {
    console.error("Error handling event", error);
    return new Response("Webhook Error !! ", { status: 400 });
  }
  return new Response("Webhook received !", { status: 200 });
}
