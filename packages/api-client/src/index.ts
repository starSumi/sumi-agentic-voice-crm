// Compatibility facade. New consumers should choose ./api and ./protocol so
// transport behavior never leaks into protocol-only modules.
export * from "./api";
export * from "./protocol";
