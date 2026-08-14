# CRM owner agent

Owns command handlers, aggregate versions, idempotency, review queue and
transaction boundaries. A mutation is all-or-nothing with audit and outbox;
failed commands produce no partial business state.
