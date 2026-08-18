function requiredString(value, name, max = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${max} characters`,
    );
  return value;
}

/**
 * Claims one durable event receipt and runs a consumer exactly once per
 * tenant/consumer/event key when the handler and receipt completion share a
 * transaction. External side effects still need their own idempotency key.
 */
export async function consumeEvent({
  store,
  tenant_id,
  consumer_id,
  event,
  event_id = event?.id,
  event_type = event?.type,
  worker_id,
  lease_ms,
  signal,
  handler,
} = {}) {
  if (!store || typeof store.claimEventDelivery !== "function")
    throw new TypeError("event consumer requires a durable store");
  requiredString(tenant_id, "tenant_id");
  requiredString(consumer_id, "consumer_id");
  requiredString(event_id, "event_id");
  requiredString(worker_id, "worker_id");
  if (typeof handler !== "function")
    throw new TypeError("event consumer requires handler");
  signal?.throwIfAborted();

  const claim = await store.claimEventDelivery({
    tenant_id,
    consumer_id,
    event_id,
    event_type,
    worker_id,
    lease_ms,
  });
  if (claim.duplicate) return { duplicate: true, completed: false };
  if (!claim.claimed) return { duplicate: false, busy: true, completed: false };

  try {
    signal?.throwIfAborted();
    const result = await handler(event, {
      signal,
      tenant_id,
      consumer_id,
      event_id,
    });
    signal?.throwIfAborted();
    await store.completeEventDelivery({
      tenant_id,
      consumer_id,
      event_id,
      worker_id,
    });
    return { duplicate: false, completed: true, result };
  } catch (error) {
    // A failed handler releases the receipt without marking the event done.
    // A completion failure leaves the lease to expire so a later worker can
    // retry; releasing after an unknown commit outcome could duplicate work.
    if (error?.code !== "CRM_CONFLICT" && !signal?.aborted) {
      await store.releaseEventDelivery({
        tenant_id,
        consumer_id,
        event_id,
        worker_id,
      });
    } else if (signal?.aborted) {
      await store.releaseEventDelivery({
        tenant_id,
        consumer_id,
        event_id,
        worker_id,
      });
    }
    throw error;
  }
}
