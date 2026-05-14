// Two-step allowlist authorization
// Step 1: domain check via ALLOWED_DOMAINS env var (zero DB cost)
// Step 2: individual email check via auth_allowlist Postgres table
// TODO: implement per Phase 3 Playbook v3.5 Section 21.3
export async function isAuthorized(_email: string): Promise<boolean> {
  // Placeholder — always returns true until implemented
  return true
}
