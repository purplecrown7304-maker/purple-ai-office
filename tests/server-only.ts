// Vitest runs in Node, outside React's conditional server export resolver.
// Production modules still import server-only and Next enforces that boundary.
export {};
