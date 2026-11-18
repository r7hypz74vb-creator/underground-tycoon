# Telegram Stars payment integration

For digital products sold inside a Telegram bot / Mini App, use Telegram Stars (`XTR`) and Telegram's invoice flow.

Production flow:
1. Backend creates an invoice link with `currency: "XTR"` and a server-defined product payload.
2. Mini App opens the invoice using Telegram WebApp invoice support.
3. Bot receives `pre_checkout_query`; validate product, price, user and order state, then answer promptly.
4. Credit the product only after `successful_payment` arrives.
5. Store `telegram_payment_charge_id` under a unique constraint to make fulfillment idempotent.
6. Handle refunds/support and keep an audit trail.

Do not accept raw card data in the Mini App. Check Telegram's current official payment documentation before launch.
